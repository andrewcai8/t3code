import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(box_usage)
  `;
  if (!columns.some((column) => column.name === "origin")) {
    yield* sql`
      ALTER TABLE box_usage
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'box'
    `;
  }
});
