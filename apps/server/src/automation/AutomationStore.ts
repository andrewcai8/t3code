import {
  Automation,
  AutomationError,
  AutomationRun,
  type AutomationId,
  type AutomationRunId,
  type AutomationRunState,
  type AutomationTrigger,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

/** A run as the host keeps it: the wire shape plus the message it sends. */
export interface StoredRun extends AutomationRun {
  readonly prompt: string;
}

export interface StoredAutomation {
  readonly automation: Automation;
  readonly webhookSecretHash: string | null;
}

/** What moving a run to `state` records alongside it. */
export type RunTransition =
  | { readonly state: "attaching" }
  | { readonly state: "starting"; readonly environmentId: EnvironmentId }
  | { readonly state: "started"; readonly threadId: ThreadId }
  | { readonly state: "failed"; readonly error: string };

/** The states a run may leave, and the ones it may enter from each. */
const transitions: Record<AutomationRunState, ReadonlyArray<AutomationRunState>> = {
  provisioning: ["attaching", "failed"],
  attaching: ["starting", "failed"],
  starting: ["started", "failed"],
  started: [],
  failed: [],
};

const AutomationRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repository: Schema.String,
  branch: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  agentDriver: Schema.String,
  account: Schema.NullOr(Schema.String),
  provider: Schema.String,
  cron: Schema.NullOr(Schema.String),
  timeZone: Schema.NullOr(Schema.String),
  webhookSecretHash: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeAutomationRows = Schema.decodeUnknownEffect(Schema.Array(AutomationRow));
const decodeAutomation = Schema.decodeUnknownEffect(Automation);
const RunRow = Schema.Struct({
  ...AutomationRun.fields,
  prompt: Schema.String,
});
const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));

const toStoredAutomation = Effect.fnUntraced(function* (row: typeof AutomationRow.Type) {
  const automation = yield* decodeAutomation({
    id: row.id,
    name: row.name,
    repository: row.repository,
    branch: row.branch,
    prompt: row.prompt,
    agentDriver: row.agentDriver,
    account: row.account,
    provider: row.provider,
    schedule:
      row.cron === null || row.timeZone === null
        ? null
        : { cron: row.cron, timeZone: row.timeZone },
    webhook: row.webhookSecretHash !== null,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return { automation, webhookSecretHash: row.webhookSecretHash } satisfies StoredAutomation;
});

const storeError = (cause: unknown) =>
  new AutomationError({ message: `Automations could not be read or saved: ${String(cause)}` });

export class AutomationStore extends Context.Service<
  AutomationStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredAutomation>, AutomationError>;
    readonly get: (
      id: AutomationId,
    ) => Effect.Effect<Option.Option<StoredAutomation>, AutomationError>;
    readonly byWebhookHash: (
      hash: string,
    ) => Effect.Effect<Option.Option<StoredAutomation>, AutomationError>;
    /** Inserts or replaces an automation. `webhook` false in the automation clears the hash. */
    readonly save: (stored: StoredAutomation) => Effect.Effect<void, AutomationError>;
    /** Deletes an automation and its run history. */
    readonly remove: (id: AutomationId) => Effect.Effect<void, AutomationError>;
    /**
     * Records a run unless one already holds its `requestId`, and returns whichever run holds
     * it. A repeated trigger therefore resolves to the run it already started.
     */
    readonly insertRun: (
      run: StoredRun,
    ) => Effect.Effect<{ readonly run: StoredRun; readonly created: boolean }, AutomationError>;
    /** Moves a run out of `from`. Returns null when it had already left `from`. */
    readonly advanceRun: (
      id: AutomationRunId,
      from: AutomationRunState,
      next: RunTransition,
      now: string,
    ) => Effect.Effect<StoredRun | null, AutomationError>;
    readonly listRuns: (
      automationId: AutomationId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredRun>, AutomationError>;
    /** Runs a restart left between triggered and started. */
    readonly unfinishedRuns: Effect.Effect<ReadonlyArray<StoredRun>, AutomationError>;
    /** The latest cron slot this automation already ran, as an ISO time. */
    readonly lastCronSlot: (
      automationId: AutomationId,
    ) => Effect.Effect<string | null, AutomationError>;
    readonly countRunsSince: (
      automationId: AutomationId,
      trigger: AutomationTrigger,
      since: string,
    ) => Effect.Effect<number, AutomationError>;
  }
>()("t3/automation/AutomationStore") {
  static readonly layer = Layer.effect(
    AutomationStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readAutomations = (where: Statement.Fragment) =>
        sql`
        SELECT id, name, repository, branch, prompt, agent_driver AS "agentDriver",
          provider_instance_id AS account, provider, cron, timezone AS "timeZone",
          webhook_secret_hash AS "webhookSecretHash", enabled,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM automations ${where}
        ORDER BY created_at, id
      `.pipe(
          Effect.flatMap(decodeAutomationRows),
          Effect.flatMap((rows) => Effect.forEach(rows, toStoredAutomation)),
          Effect.mapError(storeError),
        );
      const runColumns = sql`
        id, automation_id AS "automationId", trigger, scheduled_for AS "scheduledFor",
        request_id AS "requestId", prompt, state, child_environment_id AS "environmentId",
        thread_id AS "threadId", error, created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const readRuns = (query: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
        query.pipe(
          Effect.flatMap(decodeRunRows),
          Effect.map((rows): ReadonlyArray<StoredRun> => rows),
          Effect.mapError(storeError),
        );
      const first = <A>(rows: ReadonlyArray<A>) => Option.fromNullishOr(rows[0]);

      return {
        list: readAutomations(sql``),
        get: (id) => readAutomations(sql`WHERE id = ${id}`).pipe(Effect.map(first)),
        byWebhookHash: (hash) =>
          readAutomations(sql`WHERE webhook_secret_hash = ${hash}`).pipe(Effect.map(first)),
        save: ({ automation, webhookSecretHash }) =>
          sql`
            INSERT INTO automations (id, name, repository, branch, prompt, agent_driver,
              provider_instance_id, provider, cron, timezone, webhook_secret_hash, enabled,
              created_at, updated_at)
            VALUES (${automation.id}, ${automation.name}, ${automation.repository},
              ${automation.branch}, ${automation.prompt}, ${automation.agentDriver},
              ${automation.account}, ${automation.provider}, ${automation.schedule?.cron ?? null},
              ${automation.schedule?.timeZone ?? null},
              ${automation.webhook ? webhookSecretHash : null}, ${automation.enabled ? 1 : 0},
              ${automation.createdAt}, ${automation.updatedAt})
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, repository = excluded.repository,
              branch = excluded.branch, prompt = excluded.prompt,
              agent_driver = excluded.agent_driver,
              provider_instance_id = excluded.provider_instance_id, provider = excluded.provider,
              cron = excluded.cron, timezone = excluded.timezone,
              webhook_secret_hash = excluded.webhook_secret_hash, enabled = excluded.enabled,
              updated_at = excluded.updated_at
          `.pipe(Effect.asVoid, Effect.mapError(storeError)),
        remove: (id) =>
          sql
            .withTransaction(
              Effect.all([
                sql`DELETE FROM automation_runs WHERE automation_id = ${id}`,
                sql`DELETE FROM automations WHERE id = ${id}`,
              ]),
            )
            .pipe(Effect.asVoid, Effect.mapError(storeError)),
        insertRun: (run) =>
          Effect.gen(function* () {
            const inserted = yield* sql`
              INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, request_id,
                prompt, state, child_environment_id, thread_id, error, created_at, updated_at)
              VALUES (${run.id}, ${run.automationId}, ${run.trigger}, ${run.scheduledFor},
                ${run.requestId}, ${run.prompt}, ${run.state}, ${run.environmentId},
                ${run.threadId}, ${run.error}, ${run.createdAt}, ${run.updatedAt})
              ON CONFLICT(request_id) DO NOTHING
              RETURNING id
            `;
            const [stored] = yield* readRuns(
              sql`SELECT ${runColumns} FROM automation_runs WHERE request_id = ${run.requestId}`,
            );
            if (!stored) return yield* storeError("the run vanished after it was recorded");
            return { run: stored, created: inserted.length > 0 };
          }).pipe(Effect.mapError(storeError)),
        advanceRun: (id, from, next, now) => {
          if (!transitions[from].includes(next.state))
            return Effect.fail(storeError(`a run cannot move from ${from} to ${next.state}`));
          const environmentId = next.state === "starting" ? next.environmentId : null;
          const threadId = next.state === "started" ? next.threadId : null;
          const error = next.state === "failed" ? next.error : null;
          return readRuns(sql`
            UPDATE automation_runs SET state = ${next.state},
              child_environment_id = COALESCE(${environmentId}, child_environment_id),
              thread_id = COALESCE(${threadId}, thread_id),
              error = ${error}, updated_at = ${now}
            WHERE id = ${id} AND state = ${from}
            RETURNING ${runColumns}
          `).pipe(Effect.map((rows) => rows[0] ?? null));
        },
        listRuns: (automationId, limit) =>
          readRuns(sql`
            SELECT ${runColumns} FROM automation_runs WHERE automation_id = ${automationId}
            ORDER BY created_at DESC, id DESC LIMIT ${limit}
          `),
        unfinishedRuns: readRuns(sql`
          SELECT ${runColumns} FROM automation_runs
          WHERE state IN ('provisioning', 'attaching', 'starting') ORDER BY created_at, id
        `),
        lastCronSlot: (automationId) =>
          sql<{ readonly slot: string | null }>`
            SELECT MAX(scheduled_for) AS slot FROM automation_runs
            WHERE automation_id = ${automationId} AND trigger = 'cron'
          `.pipe(
            Effect.map((rows) => rows[0]?.slot ?? null),
            Effect.mapError(storeError),
          ),
        countRunsSince: (automationId, trigger, since) =>
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM automation_runs
            WHERE automation_id = ${automationId} AND trigger = ${trigger} AND created_at >= ${since}
          `.pipe(
            Effect.map((rows) => rows[0]?.count ?? 0),
            Effect.mapError(storeError),
          ),
      };
    }),
  );
}
