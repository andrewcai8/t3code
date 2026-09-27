import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A null `model` runs each chat on the agent's default model.
  yield* sql`ALTER TABLE automations ADD COLUMN model TEXT`;
});
