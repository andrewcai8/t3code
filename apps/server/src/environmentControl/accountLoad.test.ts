import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadSession,
} from "../persistence/Services/ProjectionThreadSessions.ts";
import { readAccountLoad } from "./accountLoad.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

const layer = ProjectionThreadSessionRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const session = (
  threadId: string,
  status: ProjectionThreadSession["status"],
  providerInstanceId: string | null,
): ProjectionThreadSession => ({
  threadId: ThreadId.make(threadId),
  status,
  providerName: "claudeAgent",
  providerInstanceId:
    providerInstanceId === null ? null : ProviderInstanceId.make(providerInstanceId),
  runtimeMode: "full-access",
  activeTurnId: status === "running" ? TurnId.make(`${threadId}-turn`) : null,
  lastError: null,
  updatedAt: "2026-09-23T12:00:00.000Z",
});

it.effect("counts awake cloud boxes and local running turns per account", () =>
  Effect.gen(function* () {
    const leases = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
    const sessions = yield* ProjectionThreadSessionRepository;
    yield* Effect.promise(async () => {
      for (const [leaseId, providerInstanceId] of [
        ["awake-1", "claude-work"],
        ["awake-2", "claude-work"],
        ["awake-3", "codex-personal"],
        ["paused", "claude-personal"],
        ["disposed", "claude-personal"],
      ] as const)
        await leases.register({ leaseId, sandboxId: `${leaseId}-box`, providerInstanceId });
      await leases.markPaused("paused");
      await leases.markDisposed("disposed");
    });
    for (const row of [
      session("running-work", "running", "claude-work"),
      session("running-personal", "running", "claude-personal"),
      session("ready-personal", "ready", "claude-personal"),
      session("idle-codex", "idle", "codex-personal"),
      session("running-legacy", "running", null),
    ])
      yield* sessions.upsert(row);

    expect(yield* readAccountLoad(leases, sessions)).toEqual(
      new Map([
        ["claude-work", 3],
        ["codex-personal", 1],
        ["claude-personal", 1],
      ]),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("counts an awake box against its companions' accounts too", () =>
  Effect.gen(function* () {
    const leases = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
    const sessions = yield* ProjectionThreadSessionRepository;
    yield* Effect.promise(async () => {
      await leases.register({
        leaseId: "claude-chat",
        sandboxId: "claude-chat-box",
        providerInstanceId: "claude-work",
        companionInstanceIds: ["codex-spare", "cursor-work"],
      });
      await leases.register({
        leaseId: "codex-chat",
        sandboxId: "codex-chat-box",
        providerInstanceId: "codex-spare",
        companionInstanceIds: ["claude-work", "cursor-home"],
      });
    });

    expect(yield* readAccountLoad(leases, sessions)).toEqual(
      new Map([
        ["claude-work", 2],
        ["codex-spare", 2],
        ["cursor-work", 1],
        ["cursor-home", 1],
      ]),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("counts local turns alone when cloud leases cannot be read", () =>
  Effect.gen(function* () {
    const sessions = yield* ProjectionThreadSessionRepository;
    yield* sessions.upsert(session("running-work", "running", "claude-work"));
    const unreadable = { awake: () => Promise.reject(new Error("database is locked")) };

    expect(yield* readAccountLoad(unreadable, sessions)).toEqual(new Map([["claude-work", 1]]));
  }).pipe(Effect.provide(layer)),
);
