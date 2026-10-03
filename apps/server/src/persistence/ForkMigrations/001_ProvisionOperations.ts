import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provision_operations (
      request_id TEXT PRIMARY KEY NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE TABLE provisioned_leases (lease_id TEXT PRIMARY KEY NOT NULL, lease_json TEXT NOT NULL)`;
});
