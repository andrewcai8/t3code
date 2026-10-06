import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Where a scheduled task fires. Existing tasks keep running on this server. A ledger repair can
// rerun fork migrations, so the column is added only once.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "target")) return;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN target TEXT NOT NULL DEFAULT 'local'`;
});
