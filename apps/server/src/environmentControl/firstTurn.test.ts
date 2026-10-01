// @effect-diagnostics nodeBuiltinImport:off - the box is a real local HTTP server.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, EnvironmentProvisionInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProvisionControl } from "./ProvisionControl.ts";
import { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";
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
};
const input = Schema.decodeUnknownSync(EnvironmentProvisionInput)({
  requestId: "1b3650ed-0923-4876-b450-ccb4cf46a905",
  provider: "e2b",
  providerInstanceId: "codex",
  chat: { threadId: "draft-thread", firstTurn: turn },
});
const manifest = Schema.decodeUnknownSync(ProvisionPreparationManifest)({
  input,
  request: {
    ...input,
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

/** A box's T3 server as the manager sees it: one project, and a receipt per command id. */
const fakeBox = Effect.acquireRelease(
  Effect.promise(async () => {
    const commands: Array<Record<string, unknown>> = [];
    const threads: Array<{ id: string }> = [];
    const turnStarted = Deferred.makeUnsafe<void>();
    const server = NodeHttp.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer private-broker") {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "GET" && request.url === "/api/orchestration/shell") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            projects: [{ id: "box-project", workspaceRoot: "/private/operation/workspace" }],
            threads,
          }),
        );
        return;
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const command = JSON.parse(body) as Record<string, unknown>;
        if (!commands.some((seen) => seen.commandId === command.commandId)) {
          commands.push(command);
          if (command.type === "thread.create") threads.push({ id: String(command.threadId) });
          if (command.type === "thread.turn.start") Deferred.doneUnsafe(turnStarted, Effect.void);
        }
        response.writeHead(200, { "content-type": "application/json" }).end('{"sequence":1}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { origin: `http://127.0.0.1:${port}`, commands, turnStarted, server };
  }),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

it.live("starts a draft's first turn on its box and owns the box, with no client left", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
    const leases = createProvisionedLeaseRegistry(sql);
    const box = yield* fakeBox;
    const preparing = yield* Deferred.make<void>();
    const prepared = yield* Deferred.make<void>();
    let settle: (
      operation: Parameters<NonNullable<ProvisionProviderPorts["Service"]["ready"]>>[0],
    ) => Effect.Effect<void> = () => Effect.void;
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
        ready: (operation) => settle(operation),
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
      },
      leases,
    );
    settle = control.settleChat;

    // The page that pressed Send goes away mid-setup and never comes back.
    const caller = yield* Effect.forkChild(control.provision(input));
    yield* Deferred.await(preparing);
    yield* Fiber.interrupt(caller);
    yield* Deferred.succeed(prepared, undefined);
    yield* Deferred.await(box.turnStarted);
    // Joins the host's drive so its bookkeeping has settled before reading it.
    yield* control.provision(input);
    yield* control.settleChats;

    expect(box.commands).toEqual([
      {
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
      },
      {
        type: "thread.turn.start",
        commandId: `first-turn:${input.requestId}`,
        threadId: "draft-thread",
        message: { messageId: "message-1", role: "user", text: turn.text, attachments: [] },
        modelSelection: turn.modelSelection,
        titleSeed: turn.titleSeed,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: turn.createdAt,
      },
    ]);
    const lease = yield* Effect.promise(() => leases.findById(input.requestId));
    expect(lease?.owner).toEqual({ environmentId: "remote", threadId: "draft-thread" });
    expect(lease?.firstTurn).toBeUndefined();
    expect(lease?.remoteAccess?.origin).toBe(box.origin);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ProvisionOperationStore.layer.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
