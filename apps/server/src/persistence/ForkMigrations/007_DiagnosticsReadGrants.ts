import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Usage and diagnostics moved from `orchestration:read` to `diagnostics:read` (upstream #9790).
// Give grants stored before that split the new permission once, so existing pairings keep usage
// without pairing again. Grants issued afterwards keep exactly what they asked for. Idempotent,
// since a ledger repair can rerun fork migrations.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["auth_sessions", "auth_pairing_links"]) {
    yield* sql`
      UPDATE ${sql(table)}
      SET scopes = json_insert(scopes, '$[#]', 'diagnostics:read')
      WHERE EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = 'orchestration:read')
        AND NOT EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = 'diagnostics:read')
    `;
  }
});
