import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(automations)`;
  // Databases that ran this as migration 058 already have the column.
  if (columns.some((column) => column.name === "model")) return;
  // A null `model` runs each chat on the agent's default model.
  yield* sql`ALTER TABLE automations ADD COLUMN model TEXT`;
});
