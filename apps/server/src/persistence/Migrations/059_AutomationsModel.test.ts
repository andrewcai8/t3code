import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateAutomationsModel from "./059_AutomationsModel.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("059_AutomationsModel", (it) => {
  it.effect("adds the model column empty for existing automations and re-runs as a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO automations (
          id, name, repository, prompt, agent_driver, provider, schedule_since, enabled,
          created_at, updated_at
        ) VALUES (
          'nightly', 'Nightly', 'andrewcai8/t3code', 'Bump dependencies.', 'codex', 'e2b',
          ${now}, 1, ${now}, ${now}
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 59 });
      const migrated = yield* sql<{ readonly model: string | null }>`
        SELECT model FROM automations WHERE id = 'nightly'
      `;
      assert.deepEqual(migrated, [{ model: null }]);

      yield* sql`UPDATE automations SET model = 'gpt-6-mini' WHERE id = 'nightly'`;
      yield* migrateAutomationsModel;
      const rows = yield* sql<{ readonly model: string | null }>`
        SELECT model FROM automations WHERE id = 'nightly'
      `;
      assert.deepEqual(rows, [{ model: "gpt-6-mini" }]);
    }),
  );
});
