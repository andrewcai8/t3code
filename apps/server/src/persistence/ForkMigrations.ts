/**
 * This fork's migrations, recorded in their own ledger so upstream's ids and files stay upstream's.
 *
 * `withForkMigrations` wraps upstream's `runMigrations`: it first moves any fork rows out of
 * upstream's ledger, then lets upstream migrate, then runs the fork migrations below.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { RunMigrationsOptions } from "./Migrations.ts";
import ProvisionOperations from "./ForkMigrations/001_ProvisionOperations.ts";
import BoxUsage from "./ForkMigrations/002_BoxUsage.ts";
import BoxUsageOrigin from "./ForkMigrations/003_BoxUsageOrigin.ts";
import ProvisionedChats from "./ForkMigrations/004_ProvisionedChats.ts";
import ProvisionedChatsV2 from "./ForkMigrations/005_ProvisionedChatsV2.ts";
import ScheduledTaskTarget from "./ForkMigrations/006_ScheduledTaskTarget.ts";

export const forkMigrationEntries = [
  [1, "ProvisionOperations", ProvisionOperations],
  [2, "BoxUsage", BoxUsage],
  [3, "BoxUsageOrigin", BoxUsageOrigin],
  [4, "ProvisionedChats", ProvisionedChats],
  [5, "ProvisionedChatsV2", ProvisionedChatsV2],
  [6, "ScheduledTaskTarget", ScheduledTaskTarget],
] as const;

// Fork migrations that older builds recorded in upstream's ledger and that no longer run. The
// tables they created stay where they were; new databases never get them.
const droppedForkMigrations = new Set([
  "ProjectionThreadHandoff",
  "Automations",
  "AutomationsModel",
]);

const forkTable = "fork_sql_migrations";
const forkIds = new Map<string, number>(forkMigrationEntries.map(([id, name]) => [name, id]));

const runFork = Migrator.make({});
const forkLoader = Migrator.fromRecord(
  Object.fromEntries(
    forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

/**
 * Older fork builds interleaved fork migrations with upstream's in `effect_sql_migrations`. By name,
 * give each upstream migration upstream's id and move each fork migration to the fork ledger, so
 * upstream's migrator resumes after the last upstream migration that ran. A ledger with no fork
 * rows (fresh, upstream, already repaired) is left alone.
 */
const moveForkLedger = Effect.fn("moveForkLedger")(function* (
  upstreamIds: ReadonlyMap<string, number>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return;
      const rows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations`;
      const isFork = (name: string) => forkIds.has(name) || droppedForkMigrations.has(name);
      if (!rows.some((row) => isFork(row.name))) return;

      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(forkTable)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      const moved = rows.filter(
        (row) =>
          isFork(row.name) || (upstreamIds.get(row.name) ?? row.migration_id) !== row.migration_id,
      );
      // Delete every moved row before inserting any, so a new id never collides with an old one.
      for (const row of moved) {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id}`;
      }
      for (const row of moved) {
        const forkId = forkIds.get(row.name);
        const upstreamId = upstreamIds.get(row.name);
        if (forkId !== undefined) {
          yield* sql`
            INSERT OR IGNORE INTO ${sql(forkTable)} (migration_id, name, created_at)
            VALUES (${forkId}, ${row.name}, ${row.created_at})
          `;
        } else if (upstreamId !== undefined) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES (${upstreamId}, ${row.name}, ${row.created_at})
          `;
        }
      }
    }),
  );
});

/** Pipe for upstream's `runMigrations`; fork migrations run only on a full migration. */
export const withForkMigrations =
  (upstreamManifest: ReadonlyArray<readonly [number, string]>) =>
  <A, E, R>(runUpstream: Effect.Effect<A, E, R>, options?: RunMigrationsOptions) =>
    Effect.gen(function* () {
      yield* moveForkLedger(new Map(upstreamManifest.map(([id, name]) => [name, id])));
      const executed = yield* runUpstream;
      if (options?.toMigrationInclusive !== undefined) return executed;
      const forkExecuted = yield* runFork({ loader: forkLoader, table: forkTable });
      if (forkExecuted.length > 0) {
        yield* Effect.log("Fork migrations ran successfully").pipe(
          Effect.annotateLogs({ migrations: forkExecuted.map(([id, name]) => `${id}_${name}`) }),
        );
      }
      return executed;
    });
