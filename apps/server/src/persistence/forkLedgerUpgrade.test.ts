import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ownerChat, createProvisionedChatStore } from "../environmentControl/provisionedChats.ts";
import { boxShell, boxThread } from "../environmentControl/shellTestFixture.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";

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

/** A fork host database at ledger 61: one local thread and one kept cloud chat card. */
const seedForkDatabase = (statePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
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
    const v1CardJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(v1Card);
    yield* sql`
      INSERT INTO provisioned_chats (lease_id, sequence, chat_json, read_at)
      VALUES ('lease-1', 17, ${v1CardJson}, '2026-09-30T10:06:00.000Z')
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: statePath })), Effect.scoped);

const upgradedLayer = (dbPath: string) => {
  const database = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
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

it.layer(NodeServices.layer)("fork database upgrade", (it) => {
  it.effect(
    "a fork host at ledger 61 gets V2's schema, imports its threads, and keeps its cards",
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
          const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations
            WHERE migration_id >= 61 ORDER BY migration_id
          `;
          assert.deepStrictEqual(
            ledger.map((row) => [row.migration_id, row.name]),
            [
              [61, "ProvisionedChats"],
              [62, "OrchestrationV2"],
              [63, "RemoveRedundantProjectionIndexes"],
              [64, "ProvisionedChatsV2"],
            ],
          );

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
        }).pipe(Effect.provide(upgradedLayer(v2Path)));
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a statev2 database whose ledger came from an upstream V2 build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-upstream-ledger-" }),
      );
      const v2Path = path.join(stateDir, "statev2.sqlite");

      const failure = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (52, 'ProjectionThreadTitleState'),
            (53, 'PullRequestFilesViewed'),
            (54, 'ProjectionThreadsAutoSettleDisabledAt'),
            (55, 'OrchestrationV2'),
            (56, 'RemoveRedundantProjectionIndexes')
        `;
        return yield* Effect.flip(runMigrations());
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: v2Path })), Effect.scoped);

      assert.strictEqual(
        failure.message,
        `${v2Path} was created by an upstream T3 Code build (OrchestrationV2 is migration 55, this build expects 62). Move that file aside and restart; this build recreates it from state.sqlite.`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("logs each cloud chat card it cannot convert to V2", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const encodeCard = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
      const { runtimeMode: _runtimeMode, ...threadWithoutMode } = v1Card.thread;
      const unownedThread = {
        ...v1Card.thread,
        modelSelection: { model: "claude-opus-5-5" },
        session: null,
      };

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 63 });
        yield* sql`
          INSERT INTO provisioned_chats (lease_id, sequence, chat_json, read_at) VALUES
            ('lease-truncated', 17, '{"sequence":', '2026-09-30T10:06:00.000Z'),
            ('lease-no-mode', 17, ${encodeCard({ ...v1Card, thread: threadWithoutMode })}, '2026-09-30T10:06:00.000Z'),
            ('lease-unowned', 17, ${encodeCard({ ...v1Card, thread: unownedThread })}, '2026-09-30T10:06:00.000Z')
        `;
        yield* runMigrations().pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

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
