import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerChat, createProvisionedChatStore } from "../environmentControl/provisionedChats.ts";
import { boxShell, boxThread } from "../environmentControl/shellTestFixture.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { forkMigrationEntries } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

/** A host's card as a pre-V2 build stored it: the box's V1 thread shell at the box's sequence. */
const v1Card = {
  sequence: 17,
  project: {
    id: "project-app",
    title: "t3code",
    workspaceRoot: "/home/user/work/t3code",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
  },
  thread: {
    id: "thread-app",
    projectId: "project-app",
    title: "Fix the login redirect",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    linkedPullRequest: null,
    pullRequests: [],
    branchPullRequest: null,
    latestTurn: null,
    createdAt: "2026-09-30T10:01:00.000Z",
    updatedAt: "2026-09-30T10:05:00.000Z",
    archivedAt: null,
    handoff: null,
    settledOverride: "settled",
    settledAt: "2026-09-30T11:00:00.000Z",
    session: {
      threadId: "thread-app",
      status: "stopped",
      providerName: "claudeAgent",
      providerInstanceId: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-30T10:05:00.000Z",
    },
    latestUserMessageAt: "2026-09-30T10:02:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
  },
};

const encodeCard = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const forkEraLedgerAt61 = [
  [52, "ProvisionOperations"],
  [53, "ProjectionThreadHandoff"],
  [54, "ProjectionThreadTitleState"],
  [55, "PullRequestFilesViewed"],
  [56, "Automations"],
  [57, "ProjectionThreadsAutoSettleDisabledAt"],
  [58, "BoxUsage"],
  [59, "AutomationsModel"],
  [60, "BoxUsageOrigin"],
  [61, "ProvisionedChats"],
] as const;

const expectedUpstreamAbove51: ReadonlyArray<readonly [number, string]> = [
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"],
  [58, "WebhookRelayDeliveries"],
];
/** Upstream migrations newer than any fork-era ledger, which a moved ledger still runs. */
const upstreamAfterForkEra = expectedUpstreamAbove51.filter(([id]) => id > 56);
const expectedForkLedger: ReadonlyArray<readonly [number, string]> = [
  [1, "ProvisionOperations"],
  [2, "BoxUsage"],
  [3, "BoxUsageOrigin"],
  [4, "ProvisionedChats"],
  [5, "ProvisionedChatsV2"],
  [6, "ScheduledTaskTarget"],
];

/** Replaces the ledger above upstream's shared 51 with what an older fork build recorded. */
const writeForkEraLedger = (rows: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 51`;
    yield* sql`DROP TABLE IF EXISTS fork_sql_migrations`;
    for (const [id, name] of rows) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  });

/** The schema and ledger a deployed fork build left at 61, orphan automations table included. */
const migrateLikeForkAt61 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  for (const [, , migration] of forkMigrationEntries.slice(0, 4)) yield* migration;
  yield* sql`CREATE TABLE automations (automation_id TEXT PRIMARY KEY NOT NULL)`;
  yield* writeForkEraLedger(forkEraLedgerAt61);
});

const readLedgers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upstream = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  const fork = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM fork_sql_migrations ORDER BY migration_id
  `;
  return {
    upstream: upstream.map((row): readonly [number, string] => [row.migration_id, row.name]),
    fork: fork.map((row): readonly [number, string] => [row.migration_id, row.name]),
  };
});

const assertMigratedLedgers = Effect.gen(function* () {
  const ledgers = yield* readLedgers;
  assert.deepStrictEqual(ledgers.upstream, migrationManifest);
  assert.deepStrictEqual(
    ledgers.upstream.filter(([id]) => id > 51),
    expectedUpstreamAbove51,
  );
  assert.deepStrictEqual(ledgers.fork, expectedForkLedger);
});

const tableNames = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ${sql.in(names)} ORDER BY name
    `;
    return rows.map((row) => row.name);
  });

const forkTables = [
  "automations",
  "box_usage",
  "box_usage_hours",
  "provision_operations",
  "provisioned_chats",
  "provisioned_leases",
];

/** A fork host database at ledger 61: one local thread, one cloud box, and its chat card. */
const seedForkDatabase = (statePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrateLikeForkAt61;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        'project-local', 'Local', '/work/local', '[]',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
      ) VALUES (
        'thread-local', 'project-local', 'Local chat', '{"instanceId":"codex","model":"gpt-5.5"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO provision_operations (
        request_id, request_hash, request_json, state_json, revision, created_at, updated_at
      ) VALUES ('request-1', 'hash-1', '{}', '{}', 3, '2026-09-30T09:00:00.000Z', '2026-09-30T09:01:00.000Z')
    `;
    yield* sql`INSERT INTO provisioned_leases (lease_id, lease_json) VALUES ('lease-1', '{"id":"lease-1"}')`;
    yield* sql`
      INSERT INTO box_usage (lease_id, account_ids_json, sources_json, pulled_at, origin)
      VALUES ('lease-1', '["account-1"]', '[]', '2026-09-30T10:00:00.000Z', 'box')
    `;
    yield* sql`
      INSERT INTO box_usage_hours (lease_id, hour_start, bucket_json)
      VALUES ('lease-1', '2026-09-30T10:00:00.000Z', '{"tokens":42}')
    `;
    yield* sql`
      INSERT INTO provisioned_chats (lease_id, sequence, chat_json, read_at)
      VALUES ('lease-1', 17, ${encodeCard(v1Card)}, '2026-09-30T10:06:00.000Z')
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: statePath })), Effect.scoped);

const upgradedLayer = (dbPath: string) => {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const stores = Layer.mergeAll(
    database,
    EventStore.layer.pipe(Layer.provideMerge(database)),
    ProjectionStore.layer.pipe(Layer.provideMerge(database)),
  );
  const sink = EventSink.layer.pipe(Layer.provide(stores));
  return Layer.mergeAll(
    stores,
    LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
  );
};

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

it.layer(NodeServices.layer)("fork migrations", (it) => {
  it.effect("a fresh database gets upstream's ledger, the fork ledger, and the fork tables", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* assertMigratedLedgers;
      assert.deepStrictEqual(yield* tableNames(forkTables), [
        "box_usage",
        "box_usage_hours",
        "provision_operations",
        "provisioned_chats",
        "provisioned_leases",
      ]);
    }).pipe(Effect.provide(memory)),
  );

  it.effect(
    "a fork host at ledger 61 moves to upstream's ids, gets V2, and keeps its cloud data",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-upgrade-" });
        const statePath = path.join(stateDir, "state.sqlite");
        const v2Path = path.join(stateDir, "statev2.sqlite");
        yield* seedForkDatabase(statePath);
        yield* initializeV2Database(v2Path);

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* assertMigratedLedgers;
          assert.deepStrictEqual(yield* tableNames(["orchestration_v2_events", ...forkTables]), [
            "automations",
            "box_usage",
            "box_usage_hours",
            "orchestration_v2_events",
            "provision_operations",
            "provisioned_chats",
            "provisioned_leases",
          ]);
          const [cloudRows] = yield* sql<{
            readonly operations: number;
            readonly leases: number;
            readonly usage: number;
            readonly hours: number;
            readonly origin: string;
          }>`
            SELECT
              (SELECT count(*) FROM provision_operations) AS operations,
              (SELECT count(*) FROM provisioned_leases) AS leases,
              (SELECT count(*) FROM box_usage) AS usage,
              (SELECT count(*) FROM box_usage_hours) AS hours,
              (SELECT origin FROM box_usage) AS origin
          `;
          assert.deepStrictEqual(cloudRows, {
            operations: 1,
            leases: 1,
            usage: 1,
            hours: 1,
            origin: "box",
          });

          const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          assert.deepStrictEqual(yield* importer.reconcileShells, {
            importedThreadCount: 1,
            importedMessageCount: 0,
          });
          const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getShellSnapshot();
          assert.deepStrictEqual(
            shell.threads.map((thread) => [thread.id, thread.title]),
            [["thread-local", "Local chat"]],
          );

          const chats = createProvisionedChatStore(sql);
          const card = yield* Effect.promise(() => chats.read("lease-1"));
          assert.deepStrictEqual(
            [
              card?.sequence,
              card?.project.title,
              card?.thread.title,
              card?.thread.providerInstanceId,
              card?.thread.settledOverride,
            ],
            [17, "t3code", "Fix the login redirect", "claudeAgent", "settled"],
          );

          const boxRead = ownerChat(
            boxShell([boxThread("thread-app", "project-app", "Renamed on the box")]),
            "thread-app",
          );
          if (!boxRead) return assert.fail("the box shell holds the chat");
          yield* Effect.promise(() => chats.record("lease-1", { ...boxRead, sequence: 18 }));
          const replaced = yield* Effect.promise(() => chats.read("lease-1"));
          assert.deepStrictEqual(
            [replaced?.sequence, replaced?.thread.title],
            [18, "Renamed on the box"],
          );

          const schema = sql<{ readonly name: string; readonly sql: string | null }>`
            SELECT name, sql FROM sqlite_master ORDER BY name
          `;
          const before = { schema: yield* schema, ledgers: yield* readLedgers };
          assert.deepStrictEqual(yield* runMigrations(), []);
          assert.deepStrictEqual({ schema: yield* schema, ledgers: yield* readLedgers }, before);
        }).pipe(Effect.provide(upgradedLayer(v2Path)));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a database from the fork's 62-64 numbering moves and runs only newer upstream migrations",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 56 });
        for (const [, , migration] of forkMigrationEntries.slice(0, 5)) yield* migration;
        yield* writeForkEraLedger([
          ...forkEraLedgerAt61,
          [62, "OrchestrationV2"],
          [63, "RemoveRedundantProjectionIndexes"],
          [64, "ProvisionedChatsV2"],
        ]);
        assert.deepStrictEqual(yield* runMigrations(), upstreamAfterForkEra);
        yield* assertMigratedLedgers;
      }).pipe(Effect.provide(memory)),
  );

  it.effect("an upstream V2 database keeps its ledger and gains the fork ledger", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      assert.deepStrictEqual(
        yield* tableNames(["fork_sql_migrations", "provision_operations"]),
        [],
      );
      assert.deepStrictEqual(yield* runMigrations(), upstreamAfterForkEra);
      yield* assertMigratedLedgers;
      assert.deepStrictEqual(yield* tableNames(["provision_operations", "provisioned_chats"]), [
        "provision_operations",
        "provisioned_chats",
      ]);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("logs each cloud chat card it cannot convert to V2", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const { runtimeMode: _runtimeMode, ...threadWithoutMode } = v1Card.thread;
      const unownedThread = {
        ...v1Card.thread,
        modelSelection: { model: "claude-opus-5-5" },
        session: null,
      };

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateLikeForkAt61;
        yield* sql`
          INSERT INTO provisioned_chats (lease_id, sequence, chat_json, read_at) VALUES
            ('lease-truncated', 17, '{"sequence":', '2026-09-30T10:06:00.000Z'),
            ('lease-no-mode', 17, ${encodeCard({ ...v1Card, thread: threadWithoutMode })}, '2026-09-30T10:06:00.000Z'),
            ('lease-unowned', 17, ${encodeCard({ ...v1Card, thread: unownedThread })}, '2026-09-30T10:06:00.000Z')
        `;
        yield* runMigrations().pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      }).pipe(Effect.provide(memory), Effect.scoped);

      assert.deepStrictEqual(warnings, [
        [
          "A cloud chat card was not converted to V2 and will not list",
          { leaseId: "lease-truncated", reason: "the card is not JSON" },
        ],
        [
          "A cloud chat card was not converted to V2 and will not list",
          { leaseId: "lease-no-mode", reason: "the card is not a pre-V2 chat card" },
        ],
        [
          "A cloud chat card was not converted to V2 and will not list",
          { leaseId: "lease-unowned", reason: "the card's thread names no provider instance" },
        ],
      ]);
    }),
  );
});
