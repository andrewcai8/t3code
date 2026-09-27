import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS box_usage (
      lease_id TEXT PRIMARY KEY NOT NULL,
      account_ids_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      latest_hour_start TEXT NOT NULL,
      pulled_at TEXT NOT NULL
    )
  `;
});
