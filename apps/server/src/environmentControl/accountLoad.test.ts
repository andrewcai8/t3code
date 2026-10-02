import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DurableProvisionRequest,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadSession,
} from "../persistence/Services/ProjectionThreadSessions.ts";
import { readAccountLoad } from "./accountLoad.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { resolveProvisioningProfiles } from "./ProvisioningProviderProfile.ts";

const layer = Layer.mergeAll(
  ProjectionThreadSessionRepositoryLive,
  ProvisionOperationStore.layer,
).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));
const decodeRequest = Schema.decodeUnknownEffect(DurableProvisionRequest);
const decodeSettings = Schema.decodeSync(ServerSettings);
const noOperations = { listUnresolved: Effect.succeed([]) };

/** A box request the host saved, routed to `chat` with `passengers` beside it. */
const request = (index: number, chat: string, passengers: ReadonlyArray<string> = []) =>
  decodeRequest({
    requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    provider: "e2b",
    providerInstanceId: chat,
    companionInstanceIds: passengers,
    sourceRevision: null,
    preparationHash: "b".repeat(64),
    templateId: "template",
    strategy: "direct",
  });

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

    expect(yield* readAccountLoad(leases, sessions, noOperations)).toEqual(
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

    expect(yield* readAccountLoad(leases, sessions, noOperations)).toEqual(
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

    expect(yield* readAccountLoad(unreadable, sessions, noOperations)).toEqual(
      new Map([["claude-work", 1]]),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("counts a box still provisioning, but not one being cancelled or already ended", () =>
  Effect.gen(function* () {
    const leases = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
    const sessions = yield* ProjectionThreadSessionRepository;
    const store = yield* ProvisionOperationStore;
    yield* store.accept(yield* request(1, "claude-work", ["codex-spare"]));
    const allocating = yield* store.accept(yield* request(2, "codex-spare", ["claude-home"]));
    yield* store.advance(allocating, {
      kind: "create_issued",
      issuedAt: "2026-10-02T07:33:21.000Z",
    });
    const cancelled = yield* store.accept(yield* request(3, "claude-work"));
    yield* store.advance(cancelled, {
      kind: "cancel_requested",
      recovery: null,
      resources: [],
      lastError: null,
    });
    const ended = yield* store.accept(yield* request(4, "claude-work"));
    yield* store.advance(ended, { kind: "disposed" });

    expect(yield* readAccountLoad(leases, sessions, store)).toEqual(
      new Map([
        ["claude-work", 1],
        ["codex-spare", 2],
        ["claude-home", 1],
      ]),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("spreads back-to-back launches over the accounts with the most usage left", () =>
  Effect.gen(function* () {
    const leases = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
    const sessions = yield* ProjectionThreadSessionRepository;
    const store = yield* ProvisionOperationStore;
    const apiKey = (driver: string, name: string) => ({
      driver,
      enabled: true,
      environment: [{ name, value: `${driver}-key`, sensitive: true }],
    });
    const claude = apiKey("claudeAgent", "ANTHROPIC_API_KEY");
    // Codex runs on a login file, never an API key in the environment.
    const fs = yield* FileSystem.FileSystem;
    const homes = yield* fs.makeTempDirectoryScoped();
    const codex = Effect.fn(function* (home: string) {
      yield* fs.makeDirectory(`${homes}/${home}`);
      yield* fs.writeFileString(`${homes}/${home}/auth.json`, `${home}-login`);
      return { driver: "codex", enabled: true, config: { homePath: `${homes}/${home}` } };
    });
    const settings = decodeSettings({
      providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
      providerInstances: {
        claudeAgent: claude,
        claude_xdrandom3316: claude,
        claude_shanghai11167: claude,
        codex: yield* codex("codex"),
        codex_ac1: yield* codex("codex_ac1"),
        codex_ac3: yield* codex("codex_ac3"),
        codex_personal: yield* codex("codex_personal"),
      },
    });
    // Readings the host took about an hour before the launches, as on andrew.megpt.app.
    const reading = (instanceId: string, usedPercent: number, resetsAt: string) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      usageLimits: {
        checkedAt: "2026-10-02T06:30:00.000Z",
        windows: [
          { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent, resetsAt },
        ],
      },
    });
    const nextWeek = "2026-10-06T00:00:00.000Z";
    const providers = [
      reading("claudeAgent", 78, nextWeek),
      reading("claude_xdrandom3316", 0, nextWeek),
      reading("claude_shanghai11167", 8, nextWeek),
      reading("codex", 100, "2026-10-03T18:16:00.000Z"),
      reading("codex_ac1", 2, nextWeek),
      reading("codex_ac3", 1, nextWeek),
      reading("codex_personal", 0, nextWeek),
    ];
    const launch = Effect.fn(function* (index: number) {
      const profiles = yield* resolveProvisioningProfiles(
        settings,
        { providerInstanceId: "claudeAgent", agentDriver: "claudeAgent" },
        undefined,
        {
          providers,
          now: Date.parse("2026-10-02T07:33:20.000Z") + index * 10_000,
          load: yield* readAccountLoad(leases, sessions, store),
        },
      );
      const [chat, ...passengers] = profiles.map(({ instanceId }) => instanceId);
      yield* store.accept(yield* request(index, chat!, passengers));
      return [chat, ...passengers];
    });

    const launches = [];
    for (const index of [1, 2, 3, 4, 5]) launches.push(yield* launch(index));
    expect(launches).toEqual([
      ["claude_xdrandom3316", "codex_personal"],
      ["claude_shanghai11167", "codex_ac3"],
      ["claude_xdrandom3316", "codex_ac1"],
      ["claude_shanghai11167", "codex_personal"],
      ["claude_xdrandom3316", "codex_ac3"],
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
