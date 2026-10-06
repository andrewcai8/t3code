import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS provisioned_chats (
      lease_id TEXT PRIMARY KEY NOT NULL,
      sequence INTEGER NOT NULL,
      chat_json TEXT NOT NULL,
      read_at TEXT NOT NULL
    )
  `;
});
