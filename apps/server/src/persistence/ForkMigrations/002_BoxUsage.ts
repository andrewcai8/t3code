import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS box_usage (
      lease_id TEXT PRIMARY KEY NOT NULL,
      account_ids_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      pulled_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS box_usage_hours (
      lease_id TEXT NOT NULL,
      hour_start TEXT NOT NULL,
      bucket_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS box_usage_hours_hour_start ON box_usage_hours (hour_start)`;
  yield* sql`CREATE INDEX IF NOT EXISTS box_usage_hours_lease_id ON box_usage_hours (lease_id)`;
});
