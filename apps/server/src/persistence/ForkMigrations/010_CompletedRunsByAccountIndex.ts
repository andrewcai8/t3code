import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Account routing reads each account's latest completed run on every routed message. Without
// this, that read loads every run row with its payload (about a minute cold on a 50 GB database).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_completed_by_account_idx
    ON orchestration_v2_projection_runs(provider_instance_id, requested_at)
    WHERE status = 'completed'
  `;
});
