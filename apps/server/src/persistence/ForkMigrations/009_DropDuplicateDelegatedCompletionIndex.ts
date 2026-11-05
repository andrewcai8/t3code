import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream 079 builds the same partial index as orchestration_v2_projection_runs_delegated_delivery_idx.
// Two identical indexes double the write cost, and the planner may pick either.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_runs_delegated_completion_idx`;
});
