// @effect-diagnostics nodeBuiltinImport:off - the box is a real local HTTP server.
// @effect-diagnostics globalDate:off globalDateInEffect:off - a lease is registered at a past time.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EnvironmentProvisionInput,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProvisionFirstTurn,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProvisionControl } from "./ProvisionControl.ts";
import { ProvisionPreparationManifest, provisionDigest } from "./ProvisionPreparation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderPorts } from "./Provisioning.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { deliverFirstTurn } from "./firstTurn.ts";

const turn = {
  messageId: "message-1",
  text: "hi are u in a macos computer and have like ios sim build etc?",
  title: "hi are u in a macos computer",
  titleSeed: "hi are u in a macos computer and have like ios sim build etc?",
  modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-01T00:01:27.000Z",
} as ProvisionFirstTurn;
const input = Schema.decodeUnknownSync(EnvironmentProvisionInput)({
  requestId: "1b3650ed-0923-4876-b450-ccb4cf46a905",
  provider: "e2b",
  providerInstanceId: "codex",
  chat: { threadId: "draft-thread", firstTurn: turn },
});
// As freeze stores it: the request keeps the message's digest, never the message.
const manifest = Schema.decodeUnknownSync(ProvisionPreparationManifest)({
  input: { ...input, chat: { threadId: "draft-thread" } },
  request: {
    requestId: input.requestId,
    provider: "e2b",
    providerInstanceId: "codex",
    chat: { threadId: "draft-thread", firstTurnSha256: provisionDigest(stableStringify(turn)) },
    sourceRevision: null,
    templateId: "template",
    strategy: "direct",
    preparationHash: "a".repeat(64),
  },
  preparation: {
    requestId: input.requestId,
    root: "/private/operation",
    repository: null,
    artifact: {
      archivePath: "/private/archive",
      sha256: "b".repeat(64),
      revision: "c".repeat(40),
      entrypoint: "dist/bin.mjs",
    },
    runtimeExecutable: "node",
    port: 3773,
    readinessTimeoutSeconds: 180,
    brokerTtl: "7d",
    files: [],
  },
  localArtifact: {
    path: "/private/archive",
    sha256: "b".repeat(64),
    revision: "c".repeat(40),
    entrypoint: "dist/bin.mjs",
    runtimeExecutable: "node",
  },
  egressAllow: [],
});
const launch = {
  commandId: `first-turn:${input.requestId}`,
  creationSource: "server",
  threadId: "draft-thread",
  projectId: "box-project",
  title: turn.title,
  generateTitle: true,
  modelSelection: turn.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: { messageId: "message-1", text: turn.text, attachments: [] },
};

interface BoxBehavior {
  /** Requests answered 503 before the box starts answering. */
  readonly unavailableFor?: number;
  /** The box turns the launch away as an invalid command. */
  readonly rejectLaunch?: boolean;
  /** A page already started the same message on the box. */
  readonly alreadySent?: boolean;
  /** The box takes requests and never answers them. */
  readonly hang?: boolean;
}

/** A box's T3 server as the manager sees it: one project, and a receipt per command id. */
const fakeBox = (behavior: BoxBehavior) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const commands: Array<Record<string, unknown>> = [];
      const threads: Array<{ id: string; messages: Array<{ id: string }> }> = behavior.alreadySent
        ? [{ id: "draft-thread", messages: [{ id: "message-1" }] }]
        : [];
      const turnStarted = Deferred.makeUnsafe<void>();
      let unavailable = behavior.unavailableFor ?? 0;
      const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      const server = NodeHttp.createServer((request, response) => {
        if (
          request.headers.authorization !== "Bearer private-broker" ||
          request.headers["x-t3-orchestration-protocol"] !== "2"
        ) {
          response.writeHead(401).end();
          return;
        }
        if (behavior.hang) return;
        if (unavailable > 0) {
          unavailable -= 1;
          response.writeHead(503).end();
          return;
        }
        if (request.method === "GET" && request.url === "/api/orchestration/shell") {
          json(response, 200, {
            projects: [{ id: "box-project", workspaceRoot: "/private/operation/workspace" }],
            threads: threads.map(({ id }) => ({ id })),
          });
          return;
        }
        if (request.method === "GET" && request.url?.startsWith("/api/orchestration/threads/")) {
          const id = decodeURIComponent(request.url.split("/").pop() ?? "");
          const thread = threads.find((candidate) => candidate.id === id);
          if (thread)
            json(response, 200, { snapshotSequence: 1, projection: { messages: thread.messages } });
          else response.writeHead(404).end();
          return;
        }
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/api/orchestration/launch-thread") {
            response.writeHead(404).end();
            return;
          }
          const command = JSON.parse(body) as Record<string, unknown> & {
            modelSelection: { instanceId: string };
          };
          if (behavior.rejectLaunch) {
            json(response, 400, { code: "invalid_request", reason: "invalid_command" });
            return;
          }
          // A box runs each driver's one account under the driver's default instance id only.
          if (!["claudeAgent", "codex"].includes(command.modelSelection.instanceId)) {
            json(response, 500, { _tag: "ThreadLaunchError" });
            return;
          }
          const resumed = commands.some((seen) => seen.commandId === command.commandId);
          if (!resumed) {
            commands.push(command);
            threads.push({ id: String(command.threadId), messages: [{ id: "message-1" }] });
            Deferred.doneUnsafe(turnStarted, Effect.void);
          }
          json(response, 200, { threadId: command.threadId, resumed });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      return { origin: `http://127.0.0.1:${port}`, commands, turnStarted, server };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

/** A host whose provisioning drive runs the first-turn settle exactly as EnvironmentControl wires it. */
interface HostOptions {
  /** Retries right after ready; absent runs the production default. */
  readonly retry?: Schedule.Schedule<unknown>;
  /** The provider hands back a resource of the wrong kind, so the request fails. */
  readonly allocationFails?: boolean;
  /** Leaves the drive's ready hook out, holding the moment between ready and the lease. */
  readonly withoutReadyHook?: boolean;
  /** The driver the request recorded for the box. */
  readonly agentDriver?: ProviderDriverKind;
  /** The first message the host keeps, in place of `turn`. */
  readonly turn?: ProvisionFirstTurn;
}

const host = (behavior: BoxBehavior, options: HostOptions = { retry: Schedule.recurs(0) }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
    const leases = createProvisionedLeaseRegistry(sql);
    const box = yield* fakeBox(behavior);
    const preparing = yield* Deferred.make<void>();
    const prepared = yield* Deferred.make<void>();
    const kept = new Map([[input.requestId, options.turn ?? turn]]);
    const frozen =
      options.agentDriver === undefined
        ? manifest
        : { ...manifest, request: { ...manifest.request, agentDriver: options.agentDriver } };
    let settle: (
      operation: Parameters<NonNullable<ProvisionProviderPorts["Service"]["ready"]>>[0],
    ) => Effect.Effect<unknown> = () => Effect.void;
    const provisioning = yield* Provisioning.make.pipe(
      Effect.provideService(ProvisionProviderPorts, {
        create: () =>
          Effect.succeed(
            options.allocationFails
              ? {
                  provider: "namespace" as const,
                  devboxId: "box",
                  devboxName: "box",
                  instanceId: "instance",
                  region: "iad",
                  workspaceDir: "/workspace",
                }
              : { provider: "e2b" as const, sandboxId: "sandbox" },
          ),
        recoverCreate: () => Effect.succeed([]),
        fork: () => Effect.die("unexpected fork"),
        recoverFork: () => Effect.succeed([]),
        dispose: () => Effect.void,
        prepare: () =>
          Deferred.succeed(preparing, undefined).pipe(
            Effect.andThen(Deferred.await(prepared)),
            Effect.as({
              environmentId: EnvironmentId.make("remote"),
              projectDir: "/private/operation/workspace",
              sourceRevision: null,
              preparationHash: "a".repeat(64),
              t3Revision: "c".repeat(40),
              artifactSha256: "b".repeat(64),
            }),
          ),
        ready: (operation) => Effect.asVoid(settle(operation)),
      }),
    );
    const control = makeProvisionControl(
      store,
      provisioning,
      {
        freeze: async () => frozen,
        load: async () => frozen,
        attach: async () => ({
          pairingUrl: `${box.origin}/pair#token=grant`,
          remoteAccess: { origin: box.origin, brokerToken: "private-broker" },
        }),
        touch: async () => "running" as const,
        pinnedRuntime: async () => null,
        setRuntime: async () => {
          throw new Error("Unexpected setRuntime");
        },
        prepare: () => Effect.die("Unexpected prepare"),
        deliverFirstTurn: (remote, chat) => deliverFirstTurn(remote, chat, () => undefined),
        readFirstTurn: async (frozen) => kept.get(frozen.request.requestId) ?? null,
        forgetFirstTurn: async (id) => {
          kept.delete(id);
        },
        listFirstTurns: async () => [...kept.keys()],
      },
      leases,
      options.retry,
    );
    if (!options.withoutReadyHook) settle = control.settleChat;
    const lease = () => Effect.promise(() => leases.findById(input.requestId));
    return { box, control, provisioning, leases, lease, kept, preparing, prepared };
  });

const withHost = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | ProvisionOperationStore | Scope.Scope>,
) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(
      ProvisionOperationStore.layer.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.live("starts a draft's first turn on its box and owns the box, with no client left", () =>
  withHost(
    Effect.gen(function* () {
      const { box, control, lease, kept, preparing, prepared } = yield* host({});
      // The page that pressed Send goes away mid-setup and never comes back.
      const caller = yield* Effect.forkChild(control.provision(input));
      yield* Deferred.await(preparing);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(prepared, undefined);
      yield* Deferred.await(box.turnStarted);
      // A page that comes back joins the host's drive and hears the turn already started.
      const ready = yield* control.provision(input);
      yield* control.settleChats;

      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "started" } });
      expect(box.commands).toEqual([launch]);
      expect(yield* lease()).toMatchObject({
        owner: { environmentId: "remote", threadId: "draft-thread" },
        firstTurn: { status: "started" },
        remoteAccess: { origin: box.origin },
      });
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("retries a box that is not answering yet, then upkeep starts the turn", () =>
  withHost(
    Effect.gen(function* () {
      // Two quick attempts at ready go unanswered; the next upkeep pass gets through.
      const { box, control, lease, prepared } = yield* host(
        { unavailableFor: 2 },
        { retry: Schedule.recurs(1) },
      );
      yield* Deferred.succeed(prepared, undefined);
      const ready = yield* control.provision(input);
      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "pending" } });
      expect(box.commands).toEqual([]);
      expect(yield* lease()).toMatchObject({ firstTurn: { status: "pending" } });

      yield* control.settleChats;
      expect(box.commands).toEqual([launch]);
      expect(yield* lease()).toMatchObject({ firstTurn: { status: "started" } });
    }),
  ),
);

it.live("gives up at once on a turn the box refuses, and lets the page send it", () =>
  withHost(
    Effect.gen(function* () {
      const { box, control, lease, kept, prepared } = yield* host({ rejectLaunch: true });
      yield* Deferred.succeed(prepared, undefined);
      const ready = yield* control.provision(input);
      yield* control.settleChats;

      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "failed" } });
      expect(box.commands).toEqual([]);
      expect(yield* lease()).toMatchObject({
        owner: null,
        firstTurn: { status: "failed", reason: "The box refused the turn." },
      });
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("gives up on a turn still owed past its deadline without sending it", () =>
  withHost(
    Effect.gen(function* () {
      const { box, control, leases, lease, kept, prepared } = yield* host({});
      yield* Effect.promise(() =>
        leases.register({
          leaseId: input.requestId,
          sandboxId: "sandbox",
          providerInstanceId: "codex",
          provider: "e2b",
          owner: { environmentId: "remote", threadId: "draft-thread" },
          firstTurnPending: true,
          now: new Date(Date.now() - 31 * 60_000),
        }),
      );
      yield* Deferred.succeed(prepared, undefined);
      const ready = yield* control.provision(input);

      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "failed" } });
      expect(box.commands).toEqual([]);
      expect(yield* lease()).toMatchObject({
        owner: null,
        firstTurn: { status: "failed", reason: "The box did not take the turn in time." },
      });
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("does not start a second turn for a message a page already started", () =>
  withHost(
    Effect.gen(function* () {
      const { box, control, lease, prepared } = yield* host({ alreadySent: true });
      yield* Deferred.succeed(prepared, undefined);
      const ready = yield* control.provision(input);

      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "started" } });
      expect(box.commands).toEqual([]);
      expect(yield* lease()).toMatchObject({ firstTurn: { status: "started" } });
    }),
  ),
);

it.live("deletes the first message once a turn fails outside the settle, as the reaper does", () =>
  withHost(
    Effect.gen(function* () {
      const { control, leases, kept, prepared } = yield* host({ unavailableFor: 1 });
      yield* Deferred.succeed(prepared, undefined);
      expect(yield* control.provision(input)).toMatchObject({
        environment: { firstTurn: "pending" },
      });
      yield* Effect.promise(() =>
        leases.settleFirstTurn(input.requestId, { status: "failed", reason: "overdue" }),
      );
      yield* control.settleChats;
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("deletes the first message of a draft cancelled before its box was ready", () =>
  withHost(
    Effect.gen(function* () {
      const { control, provisioning, kept, preparing } = yield* host({});
      yield* Effect.forkChild(control.provision(input));
      yield* Deferred.await(preparing);
      yield* provisioning.cancel(input.requestId);
      yield* control.settleChats;
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("deletes the first message of a request that failed", () =>
  withHost(
    Effect.gen(function* () {
      const { control, kept } = yield* host({}, { allocationFails: true });
      expect(yield* control.provision(input)).toMatchObject({ kind: "refused", reason: "failed" });
      yield* control.settleChats;
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("keeps the first message of a request still being prepared", () =>
  withHost(
    Effect.gen(function* () {
      const { control, kept, preparing } = yield* host({});
      yield* Effect.forkChild(control.provision(input));
      yield* Deferred.await(preparing);
      yield* control.settleChats;
      expect(kept.size).toBe(1);
    }),
  ),
);

it.live.each([
  ["disposed", "markDisposed"],
  ["paused", "markPaused"],
] as const)(
  "gives up and deletes the first message of a box %s before its turn",
  ([stopped, stop]) =>
    withHost(
      Effect.gen(function* () {
        const { control, leases, lease, kept, prepared } = yield* host({ unavailableFor: 1 });
        yield* Deferred.succeed(prepared, undefined);
        expect(yield* control.provision(input)).toMatchObject({
          environment: { firstTurn: "pending" },
        });
        yield* Effect.promise(() => leases[stop](input.requestId));
        yield* control.settleChats;
        expect(kept.size).toBe(0);
        expect(yield* lease()).toMatchObject({
          state: stopped,
          owner: null,
          firstTurn: { status: "failed" },
        });
      }),
    ),
);

it.live("answers ready within seconds when the box hangs, leaving later tries to upkeep", () =>
  withHost(
    Effect.gen(function* () {
      const { control, lease, prepared } = yield* host({ hang: true }, {});
      yield* Deferred.succeed(prepared, undefined);
      const started = Date.now();
      const ready = yield* control.provision(input);
      const elapsedMs = Date.now() - started;
      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "pending" } });
      expect(elapsedMs).toBeLessThan(8_000);
      expect(yield* lease()).toMatchObject({ firstTurn: { status: "pending" } });
    }),
  ),
);

it.live("keeps the first message of a ready request whose lease is not registered yet", () =>
  withHost(
    Effect.gen(function* () {
      const { box, control, provisioning, lease, kept, prepared } = yield* host(
        {},
        { withoutReadyHook: true },
      );
      yield* Deferred.succeed(prepared, undefined);
      const ready = yield* provisioning.ensure(manifest.request);
      expect(ready.state.kind).toBe("ready");
      expect(yield* lease()).toBeNull();

      yield* control.settleChats;
      expect(kept.size).toBe(1);

      expect(yield* control.settleChat(ready)).toBe("started");
      expect(box.commands).toEqual([launch]);
      expect(kept.size).toBe(0);
    }),
  ),
);

it.live("launches a turn on the box's instance for the driver of the host account it names", () =>
  Effect.gen(function* () {
    const box = yield* fakeBox({});
    const hostDrivers: Record<string, ProviderDriverKind> = {
      claude_andrewcai083: ProviderDriverKind.make("claudeAgent"),
      codex: ProviderDriverKind.make("codex"),
    };
    const deliver = (threadId: string, modelSelection: ProvisionFirstTurn["modelSelection"]) =>
      Effect.promise(() =>
        deliverFirstTurn(
          { origin: box.origin, brokerToken: "private-broker" },
          {
            requestId: threadId,
            threadId,
            projectDir: "/private/operation/workspace",
            turn: { ...turn, modelSelection },
          },
          (instanceId) => hostDrivers[instanceId],
        ),
      );
    const claude = {
      instanceId: ProviderInstanceId.make("claude_andrewcai083"),
      model: "claude-opus-4-6",
      options: [{ id: "effort", value: "high" }],
    } as ProvisionFirstTurn["modelSelection"];

    expect(yield* deliver("claude-thread", claude)).toBe("delivered");
    expect(yield* deliver("codex-thread", turn.modelSelection)).toBe("delivered");
    expect(box.commands.map((command) => command.modelSelection)).toEqual([
      {
        instanceId: "claudeAgent",
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "high" }],
      },
      { instanceId: "codex", model: "gpt-5.5" },
    ]);
  }).pipe(Effect.scoped),
);

it.live("launches a first turn for the driver its request recorded, not the host's settings", () =>
  withHost(
    Effect.gen(function* () {
      // The host no longer knows the account the turn names, as after deleting that instance.
      const { box, control, prepared } = yield* host(
        {},
        {
          retry: Schedule.recurs(0),
          agentDriver: ProviderDriverKind.make("codex"),
          turn: {
            ...turn,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex_work"),
              model: "gpt-5.5",
            } as ProvisionFirstTurn["modelSelection"],
          },
        },
      );
      yield* Deferred.succeed(prepared, undefined);
      yield* control.provision(input);
      yield* control.settleChats;

      expect(box.commands.map((command) => command.modelSelection)).toEqual([
        { instanceId: "codex", model: "gpt-5.5" },
      ]);
    }),
  ),
);
