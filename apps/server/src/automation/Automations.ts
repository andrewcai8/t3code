// @effect-diagnostics nodeBuiltinImport:off - webhook secrets are minted and hashed with node:crypto.
import * as NodeCrypto from "node:crypto";
import {
  AutomationError,
  AutomationId,
  AutomationRunId,
  ProvisionRequestId,
  recentAutomationEnvironments,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationSaveResult,
  type AutomationTrigger,
  type DiscoveredProvisionedEnvironment,
  type EnvironmentControlError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EnvironmentControl } from "../environmentControl/EnvironmentControl.ts";
import { createProvisionedLeaseRegistry } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { derivedRunId, makeAutomationRunner, runProvisionInput } from "./AutomationRunner.ts";
import {
  AutomationStore,
  isInFlight,
  type StoredAutomation,
  type StoredRun,
} from "./AutomationStore.ts";
import { dueCronSlot } from "./schedule.ts";

/** How often the scheduler looks for owed cron slots. Cron has minute resolution. */
export const SCHEDULER_TICK = Duration.seconds(30);
/** Webhook runs one automation may start per rolling hour before the link answers 429. */
const WEBHOOK_RUNS_PER_HOUR = 20;
/** How much of a webhook request body reaches the prompt. */
const WEBHOOK_CONTEXT_BYTES = 16 * 1024;
const MAX_RUN_HISTORY = 50;

export type WebhookTarget =
  | { readonly kind: "found"; readonly automation: Automation }
  | { readonly kind: "not-found" }
  | { readonly kind: "disabled" };

export type WebhookOutcome =
  | { readonly kind: "accepted"; readonly run: AutomationRun }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "not-found" };

export interface WebhookDelivery {
  readonly body: string;
  readonly contentType: string | undefined;
  /** A caller's id for this delivery. A redelivery with the same id resolves to the same run. */
  readonly deliveryId: string | undefined;
}

export interface AutomationPorts {
  /** Drives a recorded run to its end. The service owns when; this owns how. */
  readonly run: (automation: Automation, run: StoredRun) => Effect.Effect<unknown, AutomationError>;
  /** Disposes a failed run's machine; true once it is gone. Never fails. */
  readonly dispose: (run: StoredRun) => Effect.Effect<boolean>;
  readonly listProvisioned: Effect.Effect<
    ReadonlyArray<DiscoveredProvisionedEnvironment>,
    EnvironmentControlError
  >;
}

const hashWebhookToken = (token: string) =>
  NodeCrypto.createHash("sha256").update(token).digest("hex");

const toWire = ({
  prompt: _prompt,
  provisionInput: _provisionInput,
  provisionAccepted: _provisionAccepted,
  ...run
}: StoredRun): AutomationRun => run;

/** A run in flight with no fiber driving it is failed once it has been quiet this long. */
const ORPHANED_RUN_GRACE_MS = 2 * 60 * 1000;
const ORPHANED_RUN_ERROR = "The run stopped unexpectedly.";
const DELETED_RUN_ERROR = "The automation was deleted.";

function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** The prompt a webhook run sends: the automation's, then the request body as context. */
export function webhookPrompt(
  prompt: string,
  delivery: Pick<WebhookDelivery, "body" | "contentType">,
) {
  let body = delivery.body;
  if (delivery.contentType?.includes("json")) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Not JSON after all; pass it on as text.
    }
  }
  const bytes = Buffer.from(body, "utf8");
  const truncated = bytes.length > WEBHOOK_CONTEXT_BYTES;
  const context = truncated
    ? `${bytes.subarray(0, WEBHOOK_CONTEXT_BYTES).toString("utf8")}\n[truncated]`
    : body;
  if (context.trim() === "") return prompt;
  return `${prompt}\n\nThis run was started by a webhook. Its request body:\n\n${fenced(context)}`;
}

const invalid = (message: string) => new AutomationError({ message });
const notFound = () => invalid("This automation no longer exists.");

/** Whether an edit restarts the schedule's count: a new expression or zone, or turning it on. */
function restartsSchedule(before: Automation, after: AutomationInput): boolean {
  if (after.schedule === null) return false;
  return (
    before.schedule?.cron !== after.schedule.cron ||
    before.schedule?.timeZone !== after.schedule.timeZone ||
    (!before.enabled && after.enabled)
  );
}

export const makeAutomations = Effect.fn("makeAutomations")(function* (ports: AutomationPorts) {
  const store = yield* AutomationStore;
  const uuid = (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);
  const fibers = yield* FiberSet.make();
  /** The fiber driving each run this process launched, so deleting an automation can stop it. */
  const running = new Map<
    string,
    { readonly automationId: AutomationId; readonly fiber: Fiber.Fiber<void> }
  >();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Runs a run in the background. Only a trigger that created the run and startup's resume
   * pass call this, so no run is launched twice in one process.
   */
  const launch = (automation: Automation, run: StoredRun) =>
    ports.run(automation, run).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("automation run stopped", { runId: run.id, cause }),
      ),
      Effect.asVoid,
      Effect.ensuring(Effect.sync(() => running.delete(run.id))),
      FiberSet.run(fibers),
      Effect.map((fiber) => {
        running.set(run.id, { automationId: automation.id, fiber });
      }),
    );

  const trigger = Effect.fnUntraced(function* (
    automation: Automation,
    trigger: AutomationTrigger,
    options: {
      readonly requestKey: string | null;
      readonly scheduledFor: string | null;
      readonly prompt: string;
      readonly hourlyCap?: number;
    },
  ) {
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const requestId = ProvisionRequestId.make(
      options.requestKey === null ? yield* uuid : derivedRunId(automation.id, options.requestKey),
    );
    const inserted = yield* store.insertRun(
      {
        id: AutomationRunId.make(yield* uuid),
        automationId: automation.id,
        trigger,
        scheduledFor: options.scheduledFor,
        requestId,
        prompt: options.prompt,
        provisionInput: runProvisionInput(automation, requestId, createdAt),
        provisionAccepted: false,
        state: "provisioning",
        environmentId: null,
        threadId: null,
        error: null,
        disposedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      options.hourlyCap === undefined
        ? undefined
        : {
            since: DateTime.formatIso(DateTime.subtract(now, { hours: 1 })),
            max: options.hourlyCap,
          },
    );
    // A repeated trigger lands on the run it already recorded, and a skipped one starts nothing.
    // Resuming a run is startup's job.
    if (inserted.kind === "created" && isInFlight(inserted.run))
      yield* launch(automation, inserted.run);
    return inserted;
  });

  const load = Effect.fnUntraced(function* (id: AutomationId) {
    return yield* Option.match(yield* store.get(id), {
      onNone: () => Effect.fail(notFound()),
      onSome: Effect.succeed,
    });
  });

  const saved = (stored: StoredAutomation, webhookToken: string | null): AutomationSaveResult => ({
    automation: stored.automation,
    webhookToken,
  });
  const mintSecret = () => {
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    return { token, hash: hashWebhookToken(token) };
  };

  /** Fails a run with no live fiber, leaving its machine to the disposal sweep. */
  const failRun = (run: StoredRun, error: string) =>
    Effect.gen(function* () {
      yield* store.advanceRun(
        run.id,
        run.state,
        { state: "failed", error, disposedAt: null },
        yield* nowIso,
      );
    });

  /**
   * Keeps runs from outliving their purpose. A run in flight whose fiber died (a defect or a
   * store error) is failed. Every failed run whose provision was accepted has its machine
   * disposed, retried each tick until the manager confirms or the retention deadline has
   * already ended the machine. Runs of deleted automations are forgotten once they owe nothing.
   */
  const sweep = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const run of yield* store.unfinishedRuns) {
      if (running.has(run.id)) continue;
      if (now - Date.parse(run.updatedAt) < ORPHANED_RUN_GRACE_MS) continue;
      yield* Effect.logWarning("automation run had no fiber driving it", { runId: run.id });
      yield* failRun(run, ORPHANED_RUN_ERROR);
    }
    for (const run of yield* store.pendingDisposals) {
      const deadline = run.provisionInput.retentionDeadline;
      const expired = deadline !== undefined && Date.parse(deadline) <= now;
      if (expired || (yield* ports.dispose(run)))
        yield* store.markDisposed(run.id, expired ? deadline : yield* nowIso);
    }
    yield* store.purgeOrphanRuns;
  });

  /** Fires each enabled automation's owed cron slot, at most one each. */
  const tick = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const { automation, scheduleSince } of yield* store.list) {
      if (!automation.enabled || automation.schedule === null) continue;
      const schedule = automation.schedule;
      // One automation that fails to schedule must not stop the others.
      yield* Effect.gen(function* () {
        const slot = dueCronSlot(
          schedule,
          scheduleSince,
          yield* store.lastCronSlot(automation.id),
          now,
        );
        if (slot === null) return;
        yield* trigger(automation, "cron", {
          requestKey: `cron:${slot}`,
          scheduledFor: slot,
          prompt: automation.prompt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("automation schedule failed", { automationId: automation.id, cause }),
        ),
      );
    }
  });

  /** Picks up runs a restart interrupted, then keeps the schedule for the life of the process. */
  const start = Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const automations = new Map(
        (yield* store.list).map(({ automation }) => [automation.id, automation]),
      );
      for (const run of yield* store.unfinishedRuns) {
        const automation = automations.get(run.automationId);
        if (automation) yield* launch(automation, run);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("automation runs could not resume", { cause })),
    );
    yield* Effect.all([
      sweep.pipe(
        Effect.catchCause((cause) => Effect.logError("automation sweep failed", { cause })),
      ),
      tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("automation scheduler tick failed", { cause }),
        ),
      ),
    ]).pipe(Effect.repeat(Schedule.spaced(SCHEDULER_TICK)));
  });

  return {
    start,
    tick,
    sweep,
    list: store.list.pipe(Effect.map((all) => all.map(({ automation }) => automation))),
    create: Effect.fn("Automations.create")(function* (input: AutomationInput) {
      const now = yield* nowIso;
      const secret = input.webhook ? mintSecret() : null;
      const stored: StoredAutomation = {
        automation: {
          id: AutomationId.make(yield* uuid),
          ...input,
          createdAt: now,
          updatedAt: now,
        },
        webhookSecretHash: secret?.hash ?? null,
        scheduleSince: now,
      };
      yield* store.save(stored);
      return saved(stored, secret?.token ?? null);
    }),
    update: Effect.fn("Automations.update")(function* (id: AutomationId, input: AutomationInput) {
      const current = yield* load(id);
      const now = yield* nowIso;
      // Turning the webhook on mints a link; leaving it on keeps the one already handed out.
      const secret = input.webhook && current.webhookSecretHash === null ? mintSecret() : null;
      const stored: StoredAutomation = {
        automation: { ...current.automation, ...input, updatedAt: now },
        webhookSecretHash: secret?.hash ?? current.webhookSecretHash,
        scheduleSince: restartsSchedule(current.automation, input) ? now : current.scheduleSince,
      };
      yield* store.save(stored);
      return saved(stored, secret?.token ?? null);
    }),
    /**
     * Deletes the automation first, so no trigger can start another run, then stops its runs in
     * flight and disposes their machines. A disposal the manager cannot finish yet stays with the
     * run, which outlives the automation until the sweep completes it.
     */
    remove: Effect.fn("Automations.remove")(function* (id: AutomationId) {
      yield* store.remove(id);
      for (const [runId, entry] of running)
        if (entry.automationId === id) {
          yield* Fiber.interrupt(entry.fiber);
          running.delete(runId);
        }
      for (const run of yield* store.unfinishedRuns)
        if (run.automationId === id) yield* failRun(run, DELETED_RUN_ERROR);
      yield* sweep;
    }),
    rotateWebhook: Effect.fn("Automations.rotateWebhook")(function* (id: AutomationId) {
      const current = yield* load(id);
      if (!current.automation.webhook)
        return yield* invalid("Turn the webhook on before rotating its link.");
      const secret = mintSecret();
      const stored: StoredAutomation = {
        ...current,
        automation: { ...current.automation, updatedAt: yield* nowIso },
        webhookSecretHash: secret.hash,
      };
      yield* store.save(stored);
      return saved(stored, secret.token);
    }),
    runNow: Effect.fn("Automations.runNow")(function* (id: AutomationId) {
      const { automation } = yield* load(id);
      const inserted = yield* trigger(automation, "manual", {
        requestKey: null,
        scheduledFor: null,
        prompt: automation.prompt,
      });
      if (inserted.kind === "gone") return yield* notFound();
      if (inserted.kind === "capped") return yield* invalid("This run could not be recorded.");
      return toWire(inserted.run);
    }),
    listRuns: (id: AutomationId, limit = MAX_RUN_HISTORY) =>
      store
        .listRuns(id, Math.min(limit, MAX_RUN_HISTORY))
        .pipe(Effect.map((runs) => runs.map(toWire))),
    /** Automation runs a client may join unasked; empty without any automation. */
    listJoinable: Effect.gen(function* () {
      if ((yield* store.list).length === 0) return [];
      const discovered = yield* ports.listProvisioned.pipe(
        Effect.mapError(() => invalid("Provisioned environments could not be listed.")),
      );
      return recentAutomationEnvironments(discovered, DateTime.toEpochMillis(yield* DateTime.now));
    }),
    /** Resolves a webhook token. Callers read the request body only once this found an automation. */
    webhookTarget: Effect.fn("Automations.webhookTarget")(function* (
      token: string,
    ): Effect.fn.Return<WebhookTarget, AutomationError> {
      const found = yield* store.byWebhookHash(hashWebhookToken(token));
      if (Option.isNone(found)) return { kind: "not-found" };
      if (!found.value.automation.enabled) return { kind: "disabled" };
      return { kind: "found", automation: found.value.automation };
    }),
    deliverWebhook: Effect.fn("Automations.deliverWebhook")(function* (
      automation: Automation,
      delivery: WebhookDelivery,
    ): Effect.fn.Return<WebhookOutcome, AutomationError> {
      const inserted = yield* trigger(automation, "webhook", {
        requestKey: delivery.deliveryId === undefined ? null : `webhook:${delivery.deliveryId}`,
        scheduledFor: null,
        prompt: webhookPrompt(automation.prompt, delivery),
        hourlyCap: WEBHOOK_RUNS_PER_HOUR,
      });
      if (inserted.kind === "gone") return { kind: "not-found" };
      return inserted.kind === "capped"
        ? { kind: "rate-limited" }
        : { kind: "accepted", run: toWire(inserted.run) };
    }),
  };
});

export class Automations extends Context.Service<
  Automations,
  Omit<Effect.Success<ReturnType<typeof makeAutomations>>, "start" | "tick" | "sweep">
>()("t3/automation/Automations") {
  static readonly layer = Layer.effect(
    Automations,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const environmentControl = yield* EnvironmentControl;
      const leases = createProvisionedLeaseRegistry(sql);
      const runner = yield* makeAutomationRunner({
        environmentControl,
        remoteAccess: (leaseId) =>
          Effect.tryPromise(() => leases.findById(leaseId)).pipe(
            Effect.map((lease) => lease?.remoteAccess ?? null),
            Effect.orElseSucceed(() => null),
          ),
      });
      const context = yield* Effect.context<HttpClient.HttpClient>();
      const automations = yield* makeAutomations({
        run: (automation, run) => runner(automation, run).pipe(Effect.provide(context)),
        dispose: (run) =>
          environmentControl.dispose({ requestId: run.requestId }).pipe(
            Effect.flatMap((result) =>
              result.kind === "disposed"
                ? Effect.succeed(true)
                : Effect.logWarning("automation run machine not disposed yet", {
                    runId: run.id,
                    message: result.message,
                  }).pipe(Effect.as(false)),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("automation run machine not disposed yet", {
                runId: run.id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          ),
        listProvisioned: environmentControl.listProvisioned,
      });
      yield* forkParked(automations.start);
      return automations;
    }),
  ).pipe(Layer.provide(AutomationStore.layer));
}
