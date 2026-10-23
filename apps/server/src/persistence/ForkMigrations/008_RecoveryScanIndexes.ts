import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Startup recovery runs before the server answers anything. Without these, two
// of its candidate queries read every subagent and every run on each boot.
// Both indexes hold only live or undelivered rows, so they stay tiny.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_live_idx
    ON orchestration_v2_projection_subagents(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_delegated_completion_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
      ELSE 0 END
  `;
});
