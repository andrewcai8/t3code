import {
  Automation,
  AutomationError,
  AutomationRun,
  EnvironmentProvisionInput,
  type AutomationId,
  type AutomationRunId,
  type AutomationRunState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type * as Statement from "effect/unstable/sql/Statement";

/** A run as the host keeps it: the wire shape plus what it sends, frozen when triggered. */
export interface StoredRun extends AutomationRun {
  readonly prompt: string;
  readonly provisionInput: EnvironmentProvisionInput;
}

export interface StoredAutomation {
  readonly automation: Automation;
  readonly webhookSecretHash: string | null;
  /** No cron slot at or before this time is owed. */
  readonly scheduleSince: string;
}

/** What moving a run to `state` records alongside it. */
export type RunTransition =
  | { readonly state: "attaching" }
  | { readonly state: "starting"; readonly environmentId: EnvironmentId }
  | { readonly state: "started"; readonly threadId: ThreadId }
  | { readonly state: "failed"; readonly error: string; readonly disposedAt: string | null };

/** The states a run may leave, and the ones it may enter from each. */
const transitions: Record<AutomationRunState, ReadonlyArray<AutomationRunState>> = {
  provisioning: ["attaching", "failed"],
  attaching: ["starting", "failed"],
  starting: ["started", "failed"],
  started: [],
  failed: [],
  skipped: [],
};

const IN_FLIGHT_RUN_SKIPPED = "Skipped because the previous run was still starting.";

/** Triggered and not yet `started`, `failed`, or `skipped`. */
export const isInFlight = (run: Pick<AutomationRun, "state">) =>
  run.state === "provisioning" || run.state === "attaching" || run.state === "starting";

/** How a trigger's run was recorded. `gone` means the automation was deleted meanwhile. */
export type RunInsert =
  | { readonly kind: "created"; readonly run: StoredRun }
  | { readonly kind: "existing"; readonly run: StoredRun }
  | { readonly kind: "capped" }
  | { readonly kind: "gone" };

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
  scheduleSince: Schema.String,
  webhookSecretHash: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeRow = Schema.decodeUnknownExit(AutomationRow);
const decodeAutomation = Schema.decodeUnknownExit(Automation);
const decodeAutomationRow = (input: unknown): Exit.Exit<StoredAutomation, unknown> => {
  const decoded = decodeRow(input);
  if (Exit.isFailure(decoded)) return Exit.failCause(decoded.cause);
  const row = decoded.value;
  return Exit.map(
    decodeAutomation({
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
    }),
    (automation) => ({
      automation,
      webhookSecretHash: row.webhookSecretHash,
      scheduleSince: row.scheduleSince,
    }),
  );
};
const decodeRunRow = Schema.decodeUnknownExit(
  Schema.Struct({
    ...AutomationRun.fields,
    prompt: Schema.String,
    provisionInput: Schema.fromJsonString(EnvironmentProvisionInput),
  }),
);
const encodeProvisionInput = Schema.encodeSync(Schema.fromJsonString(EnvironmentProvisionInput));

/** Decodes each row on its own, so one row a newer or broken writer left cannot hide the rest. */
function decodeEach<A>(
  rows: ReadonlyArray<unknown>,
  decode: (row: unknown) => Exit.Exit<A, unknown>,
  table: string,
) {
  return Effect.gen(function* () {
    const decoded: Array<A> = [];
    for (const row of rows) {
      const exit = decode(row);
      if (Exit.isSuccess(exit)) decoded.push(exit.value);
      else yield* Effect.logWarning("skipping an automation row that does not decode", { table });
    }
    return decoded as ReadonlyArray<A>;
  });
}

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
    /**
     * Deletes an automation. Its runs stay until `purgeOrphanRuns`, so a machine a run started is
     * still disposed after the automation is gone.
     */
    readonly remove: (id: AutomationId) => Effect.Effect<void, AutomationError>;
    /** Whether the manager ever recorded this provision request; without it no machine exists. */
    readonly provisionRecorded: (requestId: string) => Effect.Effect<boolean, AutomationError>;
    /** Failed runs whose machine is not disposed, or found absent, yet. */
    readonly pendingDisposals: Effect.Effect<ReadonlyArray<StoredRun>, AutomationError>;
    readonly markDisposed: (
      id: AutomationRunId,
      at: string,
    ) => Effect.Effect<void, AutomationError>;
    /** Forgets the runs of deleted automations that owe no disposal. */
    readonly purgeOrphanRuns: Effect.Effect<void, AutomationError>;
    /**
     * Records a trigger's run in one statement. A `requestId` already recorded resolves to that
     * run, before any cap. Otherwise `hourlyCap` refuses the run once this automation recorded
     * that many runs of the same trigger since `since`, and a run arriving while another of the
     * automation's runs is in flight is recorded as skipped.
     */
    readonly insertRun: (
      run: StoredRun,
      hourlyCap?: { readonly since: string; readonly max: number },
    ) => Effect.Effect<RunInsert, AutomationError>;
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
    /** The latest cron slot this automation already recorded, as an ISO time. */
    readonly lastCronSlot: (
      automationId: AutomationId,
    ) => Effect.Effect<string | null, AutomationError>;
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
            schedule_since AS "scheduleSince", webhook_secret_hash AS "webhookSecretHash",
            enabled, created_at AS "createdAt", updated_at AS "updatedAt"
          FROM automations ${where}
          ORDER BY created_at, id
        `.pipe(
          Effect.mapError(storeError),
          Effect.flatMap((rows) => decodeEach(rows, decodeAutomationRow, "automations")),
        );
      const runColumns = sql`
        id, automation_id AS "automationId", trigger, scheduled_for AS "scheduledFor",
        request_id AS "requestId", prompt, provision_input AS "provisionInput", state,
        child_environment_id AS "environmentId",
        thread_id AS "threadId", error, disposed_at AS "disposedAt", created_at AS "createdAt",
        updated_at AS "updatedAt"
      `;
      const readRuns = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
        query.pipe(
          Effect.mapError(storeError),
          Effect.flatMap((rows) => decodeEach(rows, decodeRunRow, "automation_runs")),
        );
      const first = <A>(rows: ReadonlyArray<A>) => Option.fromNullishOr(rows[0]);
      const runByRequest = (requestId: string) =>
        readRuns(
          sql`SELECT ${runColumns} FROM automation_runs WHERE request_id = ${requestId}`,
        ).pipe(Effect.map(first));

      return {
        list: readAutomations(sql``),
        get: (id) => readAutomations(sql`WHERE id = ${id}`).pipe(Effect.map(first)),
        byWebhookHash: (hash) =>
          readAutomations(sql`WHERE webhook_secret_hash = ${hash}`).pipe(Effect.map(first)),
        save: ({ automation, webhookSecretHash, scheduleSince }) =>
          sql`
            INSERT INTO automations (id, name, repository, branch, prompt, agent_driver,
              provider_instance_id, provider, cron, timezone, schedule_since, webhook_secret_hash,
              enabled, created_at, updated_at)
            VALUES (${automation.id}, ${automation.name}, ${automation.repository},
              ${automation.branch}, ${automation.prompt}, ${automation.agentDriver},
              ${automation.account}, ${automation.provider}, ${automation.schedule?.cron ?? null},
              ${automation.schedule?.timeZone ?? null}, ${scheduleSince},
              ${automation.webhook ? webhookSecretHash : null}, ${automation.enabled ? 1 : 0},
              ${automation.createdAt}, ${automation.updatedAt})
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, repository = excluded.repository,
              branch = excluded.branch, prompt = excluded.prompt,
              agent_driver = excluded.agent_driver,
              provider_instance_id = excluded.provider_instance_id, provider = excluded.provider,
              cron = excluded.cron, timezone = excluded.timezone,
              schedule_since = excluded.schedule_since,
              webhook_secret_hash = excluded.webhook_secret_hash, enabled = excluded.enabled,
              updated_at = excluded.updated_at
          `.pipe(Effect.asVoid, Effect.mapError(storeError)),
        remove: (id) =>
          sql`DELETE FROM automations WHERE id = ${id}`.pipe(
            Effect.asVoid,
            Effect.mapError(storeError),
          ),
        provisionRecorded: (requestId) =>
          sql`SELECT 1 FROM provision_operations WHERE request_id = ${requestId}`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.mapError(storeError),
          ),
        pendingDisposals: readRuns(sql`
          SELECT ${runColumns} FROM automation_runs
          WHERE state = 'failed' AND disposed_at IS NULL
          ORDER BY created_at, id
        `),
        markDisposed: (id, at) =>
          sql`UPDATE automation_runs SET disposed_at = ${at} WHERE id = ${id}`.pipe(
            Effect.asVoid,
            Effect.mapError(storeError),
          ),
        purgeOrphanRuns: sql`
          DELETE FROM automation_runs
          WHERE automation_id NOT IN (SELECT id FROM automations)
            AND state NOT IN ('provisioning', 'attaching', 'starting')
            AND NOT (state = 'failed' AND disposed_at IS NULL)
        `.pipe(Effect.asVoid, Effect.mapError(storeError)),
        insertRun: (run, hourlyCap) =>
          Effect.gen(function* () {
            const inFlight = sql`
              EXISTS (SELECT 1 FROM automation_runs WHERE automation_id = ${run.automationId}
                AND state IN ('provisioning', 'attaching', 'starting'))
            `;
            // One statement, so SQLite's single writer makes the dedupe, the cap and the
            // in-flight check atomic against a burst of concurrent triggers.
            const inserted = yield* sql`
              INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, request_id,
                prompt, provision_input, state, child_environment_id, thread_id, error,
                disposed_at, created_at, updated_at)
              SELECT ${run.id}, ${run.automationId}, ${run.trigger}, ${run.scheduledFor},
                ${run.requestId}, ${run.prompt}, ${encodeProvisionInput(run.provisionInput)},
                CASE WHEN ${inFlight} THEN 'skipped' ELSE ${run.state} END, NULL, NULL,
                CASE WHEN ${inFlight} THEN ${IN_FLIGHT_RUN_SKIPPED} ELSE NULL END, NULL,
                ${run.createdAt}, ${run.updatedAt}
              WHERE NOT EXISTS (SELECT 1 FROM automation_runs WHERE request_id = ${run.requestId})
                AND EXISTS (SELECT 1 FROM automations WHERE id = ${run.automationId})
                ${
                  hourlyCap === undefined
                    ? sql``
                    : sql`AND (SELECT COUNT(*) FROM automation_runs
                        WHERE automation_id = ${run.automationId} AND trigger = ${run.trigger}
                          AND created_at >= ${hourlyCap.since}) < ${hourlyCap.max}`
                }
              ON CONFLICT(request_id) DO NOTHING
              RETURNING id
            `.pipe(Effect.mapError(storeError));
            const stored = yield* runByRequest(run.requestId);
            if (Option.isNone(stored)) {
              const automation =
                yield* sql`SELECT 1 FROM automations WHERE id = ${run.automationId}`.pipe(
                  Effect.mapError(storeError),
                );
              return automation.length === 0
                ? ({ kind: "gone" } as const)
                : ({ kind: "capped" } as const);
            }
            return {
              kind: inserted.length > 0 ? "created" : "existing",
              run: stored.value,
            } as const;
          }),
        advanceRun: (id, from, next, now) => {
          if (!transitions[from].includes(next.state))
            return Effect.fail(storeError(`a run cannot move from ${from} to ${next.state}`));
          const environmentId = next.state === "starting" ? next.environmentId : null;
          const threadId = next.state === "started" ? next.threadId : null;
          const error = next.state === "failed" ? next.error : null;
          const disposedAt = next.state === "failed" ? next.disposedAt : null;
          return readRuns(sql`
            UPDATE automation_runs SET state = ${next.state},
              child_environment_id = COALESCE(${environmentId}, child_environment_id),
              thread_id = COALESCE(${threadId}, thread_id),
              error = ${error}, disposed_at = ${disposedAt}, updated_at = ${now}
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
      };
    }),
  );
}
