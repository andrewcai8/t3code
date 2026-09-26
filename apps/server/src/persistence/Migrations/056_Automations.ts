import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A null `provider_instance_id` runs each run on the account with the most usage left. `cron`
  // and `timezone` are set together or not at all. A null `webhook_secret_hash` turns the webhook
  // off; the secret itself is never stored.
  yield* sql`
    CREATE TABLE automations (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT,
      prompt TEXT NOT NULL,
      agent_driver TEXT NOT NULL,
      provider_instance_id TEXT,
      provider TEXT NOT NULL CHECK (provider IN ('e2b', 'namespace')),
      cron TEXT,
      timezone TEXT,
      webhook_secret_hash TEXT UNIQUE,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((cron IS NULL) = (timezone IS NULL))
    )
  `;
  // `request_id` is the provision request the run drives, so a trigger that repeats (a cron slot
  // fired twice, a redelivered webhook) lands on the same row and the same machine. `prompt` is
  // the message frozen at trigger time, webhook context included, so a resumed run sends it.
  yield* sql`
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      automation_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'webhook', 'manual')),
      scheduled_for TEXT,
      request_id TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('provisioning', 'attaching', 'starting', 'started', 'failed')),
      child_environment_id TEXT,
      thread_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, created_at DESC)`;
});
