import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DurableProvisionRequest,
  EnvironmentId,
  type EnvironmentProvisionInput,
  type FleetHostRegistration,
  type FleetHostRequest,
  type FleetHostResponse,
  type FleetInvokeInput,
  ProvisionRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoxFleetClient from "./BoxFleetClient.ts";
import * as CloudFleetHost from "./CloudFleetHost.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { createProvisionedChatStore, ownerChat } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";

const decodeRequest = Schema.decodeUnknownSync(DurableProvisionRequest);
const id = (index: number) =>
  ProvisionRequestId.make(`11111111-1111-4111-a111-${String(index).padStart(12, "0")}`);
const environment = (index: number) => EnvironmentId.make(`box-${index}`);
const origin = (index: number) => `http://box-${index}.test`;
const modelSelection = { instanceId: "codex", model: "gpt-5.5" };

/** A box this host provisioned and keeps: awake or asleep, with a chat card unless it has none. */
const addBox = (
  index: number,
  box: { readonly asleep?: boolean; readonly chat?: string | null } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
    const leases = createProvisionedLeaseRegistry(sql);
    const operation = yield* store.accept(
      decodeRequest({
        requestId: id(index),
        provider: "e2b",
        providerInstanceId: "account",
        agentDriver: "codex",
        sourceRevision: null,
        repository: "acme/app",
        branch: "main",
        preparationHash: "a".repeat(64),
        strategy: "direct",
        templateId: "fixture",
      }),
    );
    yield* store.advance(operation, {
      kind: "ready",
      allocation: { kind: "direct", resource: { provider: "e2b", sandboxId: `sandbox-${index}` } },
      readiness: {
        environmentId: environment(index),
        projectDir: "/home/user/work/app",
        sourceRevision: null,
        t3Revision: "b".repeat(40),
        artifactSha256: "c".repeat(64),
        preparationHash: "a".repeat(64),
      },
    });
    const threadId = `chat-${index}`;
    yield* Effect.promise(async () => {
      await leases.register({
        leaseId: id(index),
        sandboxId: `sandbox-${index}`,
        provider: "e2b",
        providerInstanceId: "account",
        ...(box.chat === null ? {} : { owner: { environmentId: `box-${index}`, threadId } }),
      });
      await leases.markActive({
        leaseId: id(index),
        remoteAccess: { origin: origin(index), brokerToken: `token-${index}` },
      });
      if (box.chat !== undefined && box.chat !== null) {
        const chat = ownerChat(
          boxShell([boxThread(threadId, "project-app", box.chat, { modelSelection })]),
          threadId,
        );
        if (!chat) throw new Error("Expected a chat card");
        await createProvisionedChatStore(sql).record(id(index), chat);
      }
      if (box.asleep) await leases.markPaused(id(index));
    });
  });

const setup = Effect.gen(function* () {
  const resumed: Array<EnvironmentId> = [];
  const provisioned: Array<EnvironmentProvisionInput> = [];
  const invoked: Array<[string, FleetInvokeInput]> = [];
  const registrations = new Map<string, Deferred.Deferred<FleetHostRegistration>>();
  const requests = new Map<string, Queue.Queue<FleetHostRequest>>();
  for (const index of [1, 2, 3, 4]) {
    registrations.set(origin(index), yield* Deferred.make<FleetHostRegistration>());
    requests.set(origin(index), yield* Queue.unbounded<FleetHostRequest>());
  }
  const responses = yield* Queue.unbounded<FleetHostResponse>();

  const boxes = Layer.succeed(BoxFleetClient.BoxFleetClient, {
    open: (access) =>
      Effect.succeed({
        connect: (registration) =>
          Stream.unwrap(
            Deferred.succeed(registrations.get(access.origin)!, registration).pipe(
              Effect.as(Stream.fromQueue(requests.get(access.origin)!)),
            ),
          ),
        respond: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
        invoke: (input) => {
          invoked.push([access.origin, input]);
          const launched = provisioned[0]?.chat?.threadId;
          return Effect.succeed(
            input.request.op === "threads.list" && launched !== undefined
              ? {
                  projectId: null,
                  currentThreadId: null,
                  threads: [
                    {
                      threadId: launched,
                      link: `[Profile the build](t3-thread://v1/box-3/${launched})`,
                      projectId: "project-app",
                      title: "Profile the build",
                      createdBy: "user",
                      creationSource: "server",
                      status: "running",
                      latestRunId: "run-1",
                      providerInstanceId: "codex",
                      model: "gpt-5.5",
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      linkedPullRequest: null,
                      settled: false,
                      settledAt: null,
                      snoozed: false,
                      snoozedUntil: null,
                      parentThreadId: null,
                      relationshipToParent: null,
                      itemCount: 1,
                      createdAt: "2026-10-05T10:00:00.000Z",
                      updatedAt: "2026-10-05T10:00:00.000Z",
                    },
                  ],
                  nextCursor: null,
                  total: 1,
                }
              : { answeredBy: access.origin },
          );
        },
      }),
  });
  const control = Layer.mock(EnvironmentControl.EnvironmentControl)({
    namespaceProxyOrigin: () => Effect.succeed(null),
    resume: (input) => {
      resumed.push(input.environmentId);
      return Effect.succeed({ kind: "resumed" as const });
    },
    provision: (input) => {
      provisioned.push(input);
      return Effect.succeed({
        kind: "ready" as const,
        requestId: input.requestId,
        environment: {
          environmentId: environment(3),
          leaseId: id(3),
          provider: "e2b" as const,
          sandboxId: "sandbox-3",
          projectDir: "/home/user/work/app",
          providerInstanceId: "account",
          sourceRevision: null,
          t3Revision: "b".repeat(40),
          artifactSha256: "c".repeat(64),
          firstTurn: "started" as const,
          control: {
            preparationRoot: "/prep",
            brokerCredentialPath: "/prep/broker-token",
            localT3Url: "http://127.0.0.1:3773",
            runtimeExecutable: "node",
            runtimeEntrypoint: "/prep/artifact/bin.js",
          },
        },
      });
    },
  });
  const layer = CloudFleetHost.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(boxes, control, NodeCrypto.layer)),
    Layer.provideMerge(ProvisionOperationStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  /** Relays one call from box 1's chat and waits for the host's answer. */
  const relay = (target: EnvironmentId, request: FleetInvokeInput["request"]) =>
    Effect.gen(function* () {
      const host = yield* CloudFleetHost.CloudFleetHost;
      yield* host.reconcile;
      yield* Deferred.await(registrations.get(origin(1))!);
      yield* Queue.offer(requests.get(origin(1))!, {
        requestId: "request-1",
        environmentId: target,
        invoke: {
          actor: { environmentId: environment(1), threadId: ThreadId.make("chat-1") },
          request,
        },
      });
      return yield* Queue.take(responses);
    });

  return { layer, relay, resumed, provisioned, invoked, registrations };
});

/** Boxes 1 and 4 awake with chats, 2 asleep with one, and 3 awake with no chat yet. */
const withBoxes = <A, E>(
  body: (
    context: Effect.Success<typeof setup>,
  ) => Effect.Effect<A, E, CloudFleetHost.CloudFleetHost>,
) =>
  Effect.gen(function* () {
    const context = yield* setup;
    return yield* Effect.gen(function* () {
      yield* addBox(1, { chat: "Fix login" });
      yield* addBox(2, { asleep: true, chat: "Write docs" });
      yield* addBox(3, { chat: null });
      yield* addBox(4, { chat: "Ship release" });
      return yield* body(context);
    }).pipe(Effect.provide(context.layer));
  });

it.effect("offers each awake chat the other chats with their cards, waking none", () =>
  withBoxes(({ registrations, resumed }) =>
    Effect.gen(function* () {
      yield* (yield* CloudFleetHost.CloudFleetHost).reconcile;
      const registration = yield* Deferred.await(registrations.get(origin(1))!);
      expect(registration.environments).toEqual([
        {
          environmentId: "box-2",
          label: "Write docs",
          connected: true,
          chat: {
            threadId: "chat-2",
            title: "Write docs",
            status: "idle",
            updatedAt: "2026-09-30T10:05:00.000Z",
          },
        },
        {
          environmentId: "box-4",
          label: "Ship release",
          connected: true,
          chat: {
            threadId: "chat-4",
            title: "Ship release",
            status: "idle",
            updatedAt: "2026-09-30T10:05:00.000Z",
          },
        },
        {
          environmentId: "cloud:new-chat",
          label: "New cloud chat on a fresh machine",
          connected: true,
        },
      ]);
      expect(resumed).toEqual([]);
    }),
  ),
);

it.effect("lists a sleeping chat from its card without waking it", () =>
  withBoxes(({ relay, resumed, invoked }) =>
    Effect.gen(function* () {
      const response = yield* relay(environment(2), { op: "threads.list", input: {} });
      expect(response).toMatchObject({
        requestId: "request-1",
        result: {
          projectId: null,
          currentThreadId: null,
          total: 1,
          nextCursor: null,
          threads: [
            {
              threadId: "chat-2",
              title: "Write docs",
              status: "idle",
              projectId: "project-app",
              link: "[Write docs](t3-thread://v1/box-2/chat-2)",
            },
          ],
        },
      });
      expect(resumed).toEqual([]);
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("reads a sleeping chat by waking its machine once, then asking it", () =>
  withBoxes(({ relay, resumed, invoked }) =>
    Effect.gen(function* () {
      const request = { op: "threads.read" as const, input: { threadId: ThreadId.make("chat-2") } };
      const response = yield* relay(environment(2), request);
      expect(response).toEqual({
        requestId: "request-1",
        result: { answeredBy: "http://box-2.test" },
      });
      expect(resumed).toEqual(["box-2"]);
      expect(invoked).toEqual([
        ["http://box-2.test", { actor: { environmentId: "box-1", threadId: "chat-1" }, request }],
      ]);
    }),
  ),
);

it.effect("refuses an environment that is not one of the user's cloud chats", () =>
  withBoxes(({ relay, resumed, invoked }) =>
    Effect.gen(function* () {
      const response = yield* relay(EnvironmentId.make("box-9"), {
        op: "threads.read",
        input: { threadId: ThreadId.make("chat-9") },
      });
      expect(response).toMatchObject({
        requestId: "request-1",
        failure: {
          code: "environment_unavailable",
          message: "Environment box-9 is not one of your cloud chats.",
        },
      });
      expect(resumed).toEqual([]);
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("starts a new cloud chat through provisioning, once, like this chat's machine", () =>
  withBoxes(({ relay, provisioned, resumed }) =>
    Effect.gen(function* () {
      const response = yield* relay(CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, {
        op: "threads.launch",
        input: {
          title: "Profile the build",
          message: "Find the slowest step.",
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      });
      expect(provisioned).toHaveLength(1);
      const [input] = provisioned;
      expect(input).toMatchObject({
        provider: "e2b",
        providerInstanceId: "account",
        agentDriver: "codex",
        repository: "acme/app",
        branch: "main",
        chat: {
          firstTurn: {
            text: "Find the slowest step.",
            title: "Profile the build",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      });
      const threadId = input!.chat!.threadId;
      expect(response).toEqual({
        requestId: "request-1",
        result: {
          threadId,
          link: `[Profile the build](t3-thread://v1/box-3/${threadId})`,
          projectId: "project-app",
          modelSelection,
          runId: "run-1",
          status: "running",
        },
      });
      expect(resumed).toEqual([]);
    }),
  ),
);
