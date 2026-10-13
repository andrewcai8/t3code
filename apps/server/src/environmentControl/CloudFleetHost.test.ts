import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CLOUD_FORKS_ENVIRONMENT_ID,
  DurableProvisionRequest,
  EnvironmentId,
  type EnvironmentProvisionInput,
  type FleetHostRegistration,
  type FleetHostRequest,
  type FleetHostResponse,
  type FleetInvokeInput,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadRun,
  OrchestratorMcpThreadStatus,
  OrchestratorMcpThreadTimelineItem,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProvisionRequestId,
  RunId,
  RuntimeMode,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadTitleRegeneration,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoxFleetClient from "./BoxFleetClient.ts";
import * as CloudFleetHost from "./CloudFleetHost.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";
import * as WorkerForks from "./WorkerForks.ts";
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
  box: {
    readonly asleep?: boolean;
    readonly chat?: string | null;
    readonly threadId?: string;
    readonly card?: Record<string, unknown>;
  } = {},
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
    const threadId = box.threadId ?? `chat-${index}`;
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
          boxShell([boxThread(threadId, "project-app", box.chat, { modelSelection, ...box.card })]),
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
  const opened: Array<string> = [];
  const forked: Array<[string, string, FleetInvokeInput["actor"], unknown]> = [];
  const cancelled: Array<[string, unknown]> = [];
  const paused = new Set<string>();
  /** Each box's chat fields as its shell shows them now, or that its shell cannot be read. */
  const liveChats = new Map<string, Record<string, unknown> | "unreachable">();
  const started: Array<string> = [];
  const registrations = new Map<string, Queue.Queue<FleetHostRegistration>>();
  const requests = new Map<string, Queue.Queue<FleetHostRequest>>();
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    registrations.set(origin(index), yield* Queue.unbounded<FleetHostRegistration>());
    requests.set(origin(index), yield* Queue.unbounded<FleetHostRequest>());
  }
  const responses = yield* Queue.unbounded<FleetHostResponse>();
  const closed = yield* Queue.unbounded<string>();
  const provisionCalls = yield* Queue.unbounded<EnvironmentProvisionInput>();
  /** Origins that refuse fleet.connect, as a box on an older build does. */
  const oldBuilds = new Set<string>();
  const provisioning = { hangs: false };
  /** What a box answers for an op, in place of the defaults below. */
  const answers = new Map<string, unknown>();

  const boxes = Layer.succeed(BoxFleetClient.BoxFleetClient, {
    readChat: (access, ownerThreadId) => {
      const live = liveChats.get(access.origin);
      if (live === "unreachable")
        return Effect.fail(
          new BoxFleetClient.BoxUnreachableError({ origin: access.origin, cause: "down" }),
        );
      if (live === undefined) return Effect.succeed(null);
      return Effect.succeed(
        ownerChat(
          boxShell([
            boxThread(ownerThreadId, "project-app", "Fix login", { modelSelection, ...live }),
          ]),
          ownerThreadId,
        ) ?? null,
      );
    },
    open: (access) =>
      Effect.sync(() => opened.push(access.origin)).pipe(
        Effect.tap(() => Effect.addFinalizer(() => Queue.offer(closed, access.origin))),
        Effect.as({
          connect: (registration) =>
            oldBuilds.has(access.origin)
              ? Stream.fail(
                  new BoxFleetClient.BoxUnreachableError({
                    origin: access.origin,
                    cause: "fleet.connect is unknown",
                  }),
                )
              : Stream.unwrap(
                  Queue.offer(registrations.get(access.origin)!, registration).pipe(
                    Effect.as(Stream.fromQueue(requests.get(access.origin)!)),
                  ),
                ),
          // A paused box's connection is gone, so an answer sent after the pause never arrives.
          respond: (response) =>
            Effect.suspend(() =>
              paused.has(access.origin)
                ? Effect.fail(
                    new BoxFleetClient.BoxUnreachableError({
                      origin: access.origin,
                      cause: "paused",
                    }),
                  )
                : Queue.offer(responses, response).pipe(Effect.asVoid),
            ),
          invoke: (input) => {
            invoked.push([access.origin, input]);
            const launched = provisioned[0]?.chat?.threadId;
            if (answers.has(input.request.op)) return Effect.succeed(answers.get(input.request.op));
            return Effect.succeed(
              input.request.op === "threads.list" && launched !== undefined
                ? {
                    projectId: null,
                    currentThreadId: null,
                    threads: [
                      {
                        threadId: launched,
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
      ),
  });
  const control = Layer.mock(EnvironmentControl.EnvironmentControl)({
    namespaceProxyOrigin: () => Effect.succeed(null),
    resume: (input) => {
      resumed.push(input.environmentId);
      return Effect.succeed({ kind: "resumed" as const });
    },
    provision: (input) => {
      provisioned.push(input);
      if (provisioning.hangs)
        return Queue.offer(provisionCalls, input).pipe(Effect.andThen(Effect.never));
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
  const forks = Layer.mock(WorkerForks.WorkerForks)({
    run: (source, actor, input) => {
      forked.push([source.leaseId, source.sandboxId, actor, input]);
      return Effect.succeed({
        batch: { batchId: "batch-1", state: "running" as const, jobs: [] },
        // Starting captures the chat's machine, which pauses it.
        start: Effect.sync(() => {
          started.push("batch-1");
          paused.add(origin(1));
        }),
      });
    },
    // Batch 1 is chat 1's, so only box 1's lease may cancel it, as WorkerForks decides.
    cancel: (source, input) => {
      cancelled.push([source.leaseId, input]);
      return source.leaseId === id(1)
        ? Effect.succeed({
            batchId: "batch-1",
            state: "finished" as const,
            jobs: [{ index: 0, state: "cancelled" as const }],
          })
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "No fork batch batch-1 for this chat.",
            }),
          );
    },
    sweep: Effect.void,
  });
  const layer = CloudFleetHost.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(boxes, control, forks, NodeCrypto.layer)),
    Layer.provideMerge(ProvisionOperationStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  /** Box 1 relays one call, from its own chat unless `threadId` names another. */
  const send = (
    requestId: string,
    target: EnvironmentId,
    request: FleetInvokeInput["request"],
    threadId = "chat-1",
  ) =>
    Queue.offer(requests.get(origin(1))!, {
      requestId,
      environmentId: target,
      invoke: {
        actor: { environmentId: environment(1), threadId: ThreadId.make(threadId) },
        request,
      },
    });

  /** Connects box 1, relays one call from it, and waits for the host's answer. */
  const relay = (target: EnvironmentId, request: FleetInvokeInput["request"], threadId?: string) =>
    Effect.gen(function* () {
      const host = yield* CloudFleetHost.CloudFleetHost;
      yield* host.reconcile;
      yield* Queue.take(registrations.get(origin(1))!);
      yield* send("request-1", target, request, threadId);
      return yield* Queue.take(responses);
    });

  return {
    layer,
    relay,
    send,
    responses,
    resumed,
    provisioned,
    provisionCalls,
    provisioning,
    answers,
    invoked,
    registrations,
    opened,
    closed,
    oldBuilds,
    forked,
    cancelled,
    started,
    liveChats,
    requests,
  };
});

/** Boxes 1 and 4 awake with chats, 2 asleep with one, and 3 awake with no chat yet. */
const withBoxes = <A, E>(
  body: (
    context: Effect.Success<typeof setup>,
  ) => Effect.Effect<
    A,
    E,
    CloudFleetHost.CloudFleetHost | SqlClient.SqlClient | ProvisionOperationStore
  >,
  firstChat: Record<string, unknown> | null = {},
) =>
  Effect.gen(function* () {
    const context = yield* setup;
    return yield* Effect.gen(function* () {
      // A null first chat leaves box 1 with no stored card, as a box just provisioned.
      yield* addBox(1, firstChat === null ? {} : { chat: "Fix login", card: firstChat });
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
      const registration = yield* Queue.take(registrations.get(origin(1))!);
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
        {
          environmentId: "cloud:forks",
          label: "Throwaway copies of this machine, for t3_fork_run",
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

it.effect("starts a new cloud chat with one provision like this chat's machine", () =>
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
      expect(threadId.startsWith(`cloud-started:${id(1)}:`)).toBe(true);
      expect(response).toEqual({
        requestId: "request-1",
        result: {
          threadId,
          projectId: "project-app",
          modelSelection,
          runId: "run-1",
          status: "running",
          link: `[Profile the build](t3-thread://v1/box-3/${encodeURIComponent(threadId)})`,
        },
      });
      expect(resumed).toEqual([]);
    }),
  ),
);

// The thread answers as contracts defined them before #200, which each required a `link`.
const LegacyThreadListItem = Schema.Struct({
  threadId: ThreadId,
  link: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
const LegacyThreadDetail = Schema.Struct({
  threadId: ThreadId,
  link: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
const decodeLegacyList = Schema.decodeUnknownSync(
  Schema.Struct({
    projectId: Schema.NullOr(ProjectId),
    currentThreadId: Schema.NullOr(ThreadId),
    threads: Schema.Array(LegacyThreadListItem),
    nextCursor: Schema.NullOr(NonNegativeInt),
    total: NonNegativeInt,
  }),
);
const decodeLegacyRead = Schema.decodeUnknownSync(
  Schema.Struct({
    thread: LegacyThreadDetail,
    recentRuns: Schema.Array(OrchestratorMcpThreadRun),
    items: Schema.Array(OrchestratorMcpThreadTimelineItem),
    nextPosition: Schema.NullOr(NonNegativeInt),
    hasMore: Schema.Boolean,
  }),
);
const decodeLegacyLaunch = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: ThreadId,
    link: Schema.String,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
);
const resultOf = (response: FleetHostResponse) =>
  "result" in response ? response.result : response;

it.effect("answers with the thread links boxes on builds before #200 still require", () =>
  withBoxes(({ relay, send, responses, answers, provisioned }) =>
    Effect.gen(function* () {
      const listed = yield* relay(environment(2), { op: "threads.list", input: {} });
      expect(decodeLegacyList(resultOf(listed)).threads.map((thread) => thread.link)).toEqual([
        "[Write docs](t3-thread://v1/box-2/chat-2)",
      ]);

      answers.set("threads.read", {
        thread: {
          threadId: "chat-4",
          projectId: "project-app",
          title: "Ship release",
          createdBy: "user",
          creationSource: "server",
          status: "idle",
          latestRunId: null,
          activeRunId: null,
          providerInstanceId: "codex",
          model: "gpt-5.5",
          runtimeMode: "full-access",
          interactionMode: "default",
          linkedPullRequest: null,
          titleRegeneration: null,
          branch: null,
          worktreePath: null,
          parentThreadId: null,
          relationshipToParent: null,
          runCount: 0,
          itemCount: 0,
          pendingRequestCount: 0,
          archived: false,
          settled: false,
          settledAt: null,
          snoozed: false,
          snoozedUntil: null,
          createdAt: "2026-10-05T10:00:00.000Z",
          updatedAt: "2026-10-05T10:00:00.000Z",
        },
        recentRuns: [],
        items: [],
        nextPosition: null,
        hasMore: false,
      });
      yield* send("read", environment(4), {
        op: "threads.read",
        input: { threadId: ThreadId.make("chat-4") },
      });
      expect(decodeLegacyRead(resultOf(yield* Queue.take(responses))).thread.link).toBe(
        "[Ship release](t3-thread://v1/box-4/chat-4)",
      );

      yield* send("launch", CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, {
        op: "threads.launch",
        input: { title: "Profile the build", message: "Find the slowest step." },
      });
      const launched = decodeLegacyLaunch(resultOf(yield* Queue.take(responses)));
      expect(launched.link).toBe(
        `[Profile the build](t3-thread://v1/box-3/${encodeURIComponent(provisioned[0]!.chat!.threadId)})`,
      );
    }),
  ),
);

it.effect("re-registers on the same connection when another chat's card changes", () =>
  withBoxes(({ registrations, opened }) =>
    Effect.gen(function* () {
      const host = yield* CloudFleetHost.CloudFleetHost;
      yield* host.reconcile;
      yield* Queue.take(registrations.get(origin(1))!);
      yield* host.reconcile;
      const sql = yield* SqlClient.SqlClient;
      const renamed = ownerChat(
        boxShell([boxThread("chat-4", "project-app", "Ship release 2", { modelSelection })]),
        "chat-4",
      );
      yield* Effect.promise(() =>
        createProvisionedChatStore(sql).record(id(4), { ...renamed!, sequence: 43 }),
      );
      yield* host.reconcile;
      const registration = yield* Queue.take(registrations.get(origin(1))!);
      expect(registration.environments.map((environment) => environment.label)).toEqual([
        "Write docs",
        "Ship release 2",
        "New cloud chat on a fresh machine",
        "Throwaway copies of this machine, for t3_fork_run",
      ]);
      expect(opened.filter((at) => at === origin(1))).toEqual([origin(1)]);
    }),
  ),
);

it.effect("lets a chat another chat started reach the others but start no more", () =>
  withBoxes(({ registrations, relay, provisioned }) =>
    Effect.gen(function* () {
      yield* addBox(5, { chat: "Child", threadId: `cloud-started:${id(1)}:child` });
      yield* (yield* CloudFleetHost.CloudFleetHost).reconcile;
      const registration = yield* Queue.take(registrations.get(origin(5))!);
      expect(registration.environments.map((environment) => environment.environmentId)).toEqual([
        "box-1",
        "box-2",
        "box-4",
        "cloud:forks",
      ]);
      for (const index of [6, 7, 8])
        yield* addBox(index, {
          chat: `Child ${index}`,
          threadId: `cloud-started:${id(1)}:${index}`,
        });
      const response = yield* relay(CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, {
        op: "threads.launch",
        input: { title: "One more", message: "Go." },
      });
      expect(response).toMatchObject({
        failure: {
          code: "capability_denied",
          message:
            "This chat already has 4 cloud chats it started. Delete one of their machines first.",
        },
      });
      expect(provisioned).toEqual([]);
    }),
  ),
);

it.effect("refuses a new cloud chat on another agent than this machine runs", () =>
  withBoxes(({ relay, provisioned }) =>
    Effect.gen(function* () {
      const response = yield* relay(CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, {
        op: "threads.launch",
        input: {
          title: "Review",
          message: "Review the diff.",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
        },
      });
      expect(response).toMatchObject({
        failure: {
          code: "invalid_request",
          message: "A new cloud chat runs codex like this one; pick one of its models.",
        },
      });
      expect(provisioned).toEqual([]);
    }),
  ),
);

/** A request this host accepted to start a chat for box 1, still being prepared. */
const acceptPreparing = (index: number) =>
  Effect.gen(function* () {
    const store = yield* ProvisionOperationStore;
    yield* store.accept(
      decodeRequest({
        requestId: id(index),
        provider: "e2b",
        providerInstanceId: "account",
        agentDriver: "codex",
        sourceRevision: null,
        repository: "acme/app",
        preparationHash: "a".repeat(64),
        strategy: "direct",
        templateId: "fixture",
        chat: { threadId: `cloud-started:${id(1)}:${index}` },
      }),
    );
  });

it.effect("counts chats still being prepared toward the cap", () =>
  withBoxes(({ relay, provisioned }) =>
    Effect.gen(function* () {
      for (const index of [11, 12, 13, 14]) yield* acceptPreparing(index);
      const response = yield* relay(CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, {
        op: "threads.launch",
        input: { title: "Fifth", message: "Go." },
      });
      expect(response).toMatchObject({
        failure: {
          code: "capability_denied",
          message:
            "This chat already has 4 cloud chats it started. Delete one of their machines first.",
        },
      });
      expect(provisioned).toEqual([]);
    }),
  ),
);

it.effect("keeps one launch in flight per chat: a repeat joins it, another waits", () =>
  withBoxes(({ registrations, send, responses, provisioned, provisionCalls, provisioning }) =>
    Effect.gen(function* () {
      provisioning.hangs = true;
      yield* (yield* CloudFleetHost.CloudFleetHost).reconcile;
      yield* Queue.take(registrations.get(origin(1))!);
      const launch = (title: string) => ({
        op: "threads.launch" as const,
        input: { title, message: "Go." },
      });
      yield* send("first", CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, launch("Profile"));
      yield* Queue.take(provisionCalls);
      yield* send("other", CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, launch("Benchmark"));
      expect(yield* Queue.take(responses)).toMatchObject({
        requestId: "other",
        failure: {
          code: "capability_denied",
          message:
            "This chat is still starting another cloud chat. Try again once that one is ready.",
        },
      });
      yield* send("again", CloudFleetHost.NEW_CLOUD_CHAT_ENVIRONMENT_ID, launch("Profile"));
      // Both calls wait out the launch budget; time moves until both have answered.
      const answers: Array<FleetHostResponse> = [];
      for (let step = 0; step < 30 && answers.length < 2; step++) {
        yield* TestClock.adjust("10 seconds");
        const answer = yield* Queue.poll(responses);
        if (Option.isSome(answer)) answers.push(answer.value);
      }
      expect(answers.map((answer) => answer.requestId).toSorted()).toEqual(["again", "first"]);
      for (const answer of answers)
        expect(answer).toMatchObject({ failure: { code: "environment_unavailable" } });
      expect(provisioned.map((input) => input.chat?.firstTurn?.title)).toEqual(["Profile"]);
    }),
  ),
);

it.effect("lets a chat outside full-access read cards but not wake or change other chats", () =>
  withBoxes(
    ({ relay, send, responses, resumed, invoked }) =>
      Effect.gen(function* () {
        const read = yield* relay(environment(2), {
          op: "threads.read",
          input: { threadId: ThreadId.make("chat-2") },
        });
        expect(read).toMatchObject({
          failure: {
            code: "environment_unavailable",
            message: "Write docs is asleep, and only a full-access chat can wake it.",
          },
        });
        yield* send("listed", environment(2), { op: "threads.list", input: {} });
        expect(yield* Queue.take(responses)).toMatchObject({
          requestId: "listed",
          result: { total: 1 },
        });
        yield* send("sent", environment(4), {
          op: "threads.send",
          input: { threadId: ThreadId.make("chat-4"), message: "Ship it." },
        });
        expect(yield* Queue.take(responses)).toMatchObject({
          requestId: "sent",
          failure: {
            code: "capability_denied",
            message: "Changing another cloud chat needs this chat in full-access/default mode.",
          },
        });
        expect(resumed).toEqual([]);
        expect(invoked).toEqual([]);
      }),
    { interactionMode: "plan" },
  ),
);

it.effect("acts only for the box's own chat, whatever the box claims", () =>
  withBoxes(({ relay, resumed, invoked }) =>
    Effect.gen(function* () {
      const response = yield* relay(
        environment(4),
        { op: "threads.read", input: { threadId: ThreadId.make("chat-4") } },
        "chat-4",
      );
      expect(response).toMatchObject({
        failure: {
          code: "capability_denied",
          message: "Only this machine's own chat can act through its host.",
        },
      });
      expect(resumed).toEqual([]);
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("backs off from a box that refuses the fleet connection, doubling each time", () =>
  withBoxes(({ oldBuilds, opened, closed }) =>
    Effect.gen(function* () {
      oldBuilds.add(origin(4));
      const host = yield* CloudFleetHost.CloudFleetHost;
      const attempts = Effect.sync(() => opened.filter((at) => at === origin(4)).length);
      const failedOnce = Effect.gen(function* () {
        while ((yield* Queue.take(closed)) !== origin(4));
      });
      const seen: Array<number> = [];
      yield* host.reconcile;
      yield* failedOnce;
      seen.push(yield* attempts);
      yield* host.reconcile;
      seen.push(yield* attempts);
      yield* TestClock.adjust("15 seconds");
      yield* host.reconcile;
      yield* failedOnce;
      seen.push(yield* attempts);
      yield* TestClock.adjust("15 seconds");
      yield* host.reconcile;
      seen.push(yield* attempts);
      yield* TestClock.adjust("15 seconds");
      yield* host.reconcile;
      seen.push(yield* attempts);
      expect(seen).toEqual([1, 1, 2, 2, 3]);
    }),
  ),
);

it.effect("answers a fork run before starting it, since starting pauses the chat's box", () =>
  withBoxes(({ relay, forked, invoked, started }) =>
    Effect.gen(function* () {
      const jobs = [{ command: "pnpm test --shard 1/2" }];
      const response = yield* relay(CLOUD_FORKS_ENVIRONMENT_ID, {
        op: "forks.run",
        input: { jobs },
      });
      expect(response).toEqual({
        requestId: "request-1",
        result: { batchId: "batch-1", state: "running", jobs: [] },
      });
      expect(forked).toEqual([
        [id(1), "sandbox-1", { environmentId: "box-1", threadId: "chat-1" }, { jobs }],
      ]);
      expect(started).toEqual(["batch-1"]);
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("starts forks only for a chat in full-access/default mode", () =>
  withBoxes(
    ({ relay, forked }) =>
      Effect.gen(function* () {
        const response = yield* relay(CLOUD_FORKS_ENVIRONMENT_ID, {
          op: "forks.run",
          input: { jobs: [{ command: "pnpm test" }] },
        });
        expect(response).toMatchObject({ failure: { code: "capability_denied" } });
        expect(forked).toEqual([]);
      }),
    { interactionMode: "plan" },
  ),
);

it.effect("lets a chat in any mode cancel its own fork batch, and no other chat's", () =>
  withBoxes(
    ({ relay, requests, responses, registrations, cancelled }) =>
      Effect.gen(function* () {
        const input = { batchId: "batch-1" };
        const own = yield* relay(CLOUD_FORKS_ENVIRONMENT_ID, { op: "forks.cancel", input });
        expect(own).toEqual({
          requestId: "request-1",
          result: {
            batchId: "batch-1",
            state: "finished",
            jobs: [{ index: 0, state: "cancelled" }],
          },
        });
        yield* Queue.take(registrations.get(origin(4))!);
        yield* Queue.offer(requests.get(origin(4))!, {
          requestId: "request-4",
          environmentId: CLOUD_FORKS_ENVIRONMENT_ID,
          invoke: {
            actor: { environmentId: environment(4), threadId: ThreadId.make("chat-4") },
            request: { op: "forks.cancel", input },
          },
        });
        expect(yield* Queue.take(responses)).toMatchObject({
          requestId: "request-4",
          failure: { code: "invalid_request", message: "No fork batch batch-1 for this chat." },
        });
        expect(cancelled).toEqual([
          [id(1), input],
          [id(4), input],
        ]);
      }),
    { runtimeMode: "approval-required", interactionMode: "plan" },
  ),
);

it.effect("reads a chat's mode from its box when the host holds no card for it yet", () =>
  Effect.gen(function* () {
    const jobs = [{ command: "pnpm test" }];
    const outcomes = [];
    for (const live of [
      { runtimeMode: "full-access", interactionMode: "default" },
      { runtimeMode: "full-access", interactionMode: "plan" },
      "unreachable" as const,
    ]) {
      outcomes.push(
        yield* withBoxes(
          ({ relay, liveChats, forked }) =>
            Effect.gen(function* () {
              liveChats.set(origin(1), live);
              const response = yield* relay(CLOUD_FORKS_ENVIRONMENT_ID, {
                op: "forks.run",
                input: { jobs },
              });
              const sql = yield* SqlClient.SqlClient;
              const kept = yield* Effect.promise(() => createProvisionedChatStore(sql).read(id(1)));
              return {
                allowed: "result" in response,
                forked: forked.length,
                kept: kept?.thread.interactionMode ?? null,
              };
            }),
          null,
        ),
      );
    }
    expect(outcomes).toEqual([
      { allowed: true, forked: 1, kept: "default" },
      { allowed: false, forked: 0, kept: "plan" },
      { allowed: false, forked: 0, kept: null },
    ]);
  }),
);
