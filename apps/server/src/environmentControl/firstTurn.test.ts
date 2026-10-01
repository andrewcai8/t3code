// @effect-diagnostics nodeBuiltinImport:off - the box is a real local HTTP server.
// @effect-diagnostics globalDate:off - a lease is registered at a fixed past time.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EnvironmentProvisionInput,
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
const threadCreate = {
  type: "thread.create",
  commandId: `first-turn-thread:${input.requestId}`,
  threadId: "draft-thread",
  projectId: "box-project",
  title: turn.title,
  modelSelection: turn.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: turn.createdAt,
};
const turnStart = {
  type: "thread.turn.start",
  commandId: `first-turn:${input.requestId}`,
  threadId: "draft-thread",
  message: { messageId: "message-1", role: "user", text: turn.text, attachments: [] },
  modelSelection: turn.modelSelection,
  titleSeed: turn.titleSeed,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: turn.createdAt,
};

interface BoxBehavior {
  /** Requests answered 503 before the box starts answering. */
  readonly unavailableFor?: number;
  /** The box turns away `thread.create` as an invalid command. */
  readonly rejectCreate?: boolean;
  /** A page already started the same message on the box. */
  readonly alreadySent?: boolean;
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
        if (request.headers.authorization !== "Bearer private-broker") {
          response.writeHead(401).end();
          return;
        }
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
          if (thread) json(response, 200, { snapshotSequence: 1, thread });
          else response.writeHead(404).end();
          return;
        }
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const command = JSON.parse(body) as Record<string, unknown>;
          if (command.type === "thread.create" && behavior.rejectCreate) {
            json(response, 400, { code: "invalid_request", reason: "invalid_command" });
            return;
          }
          if (!commands.some((seen) => seen.commandId === command.commandId)) {
            commands.push(command);
            if (command.type === "thread.create")
              threads.push({ id: String(command.threadId), messages: [] });
            if (command.type === "thread.turn.start") Deferred.doneUnsafe(turnStarted, Effect.void);
          }
          json(response, 200, { sequence: 1 });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      return { origin: `http://127.0.0.1:${port}`, commands, turnStarted, server };
    }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

/** A host whose provisioning drive runs the first-turn settle exactly as EnvironmentControl wires it. */
const host = (behavior: BoxBehavior, retry: Schedule.Schedule<unknown> = Schedule.recurs(0)) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
    const leases = createProvisionedLeaseRegistry(sql);
    const box = yield* fakeBox(behavior);
    const preparing = yield* Deferred.make<void>();
    const prepared = yield* Deferred.make<void>();
    const kept = new Map([[input.requestId, turn]]);
    let settle: (
      operation: Parameters<NonNullable<ProvisionProviderPorts["Service"]["ready"]>>[0],
    ) => Effect.Effect<unknown> = () => Effect.void;
    const provisioning = yield* Provisioning.make.pipe(
      Effect.provideService(ProvisionProviderPorts, {
        create: () => Effect.succeed({ provider: "e2b" as const, sandboxId: "sandbox" }),
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
        freeze: async () => manifest,
        load: async () => manifest,
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
        deliverFirstTurn,
        readFirstTurn: async (frozen) => kept.get(frozen.request.requestId) ?? null,
        forgetFirstTurn: async (id) => {
          kept.delete(id);
        },
      },
      leases,
      retry,
    );
    settle = control.settleChat;
    const lease = () => Effect.promise(() => leases.findById(input.requestId));
    return { box, control, leases, lease, kept, preparing, prepared };
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
      expect(box.commands).toEqual([threadCreate, turnStart]);
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
        Schedule.recurs(1),
      );
      yield* Deferred.succeed(prepared, undefined);
      const ready = yield* control.provision(input);
      expect(ready).toMatchObject({ kind: "ready", environment: { firstTurn: "pending" } });
      expect(box.commands).toEqual([]);
      expect(yield* lease()).toMatchObject({ firstTurn: { status: "pending" } });

      yield* control.settleChats;
      expect(box.commands).toEqual([threadCreate, turnStart]);
      expect(yield* lease()).toMatchObject({ firstTurn: { status: "started" } });
    }),
  ),
);

it.live("gives up at once on a turn the box refuses, and lets the page send it", () =>
  withHost(
    Effect.gen(function* () {
      const { box, control, lease, kept, prepared } = yield* host({ rejectCreate: true });
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
