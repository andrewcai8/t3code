// @effect-diagnostics nodeBuiltinImport:off - webhook secrets are minted and hashed with node:crypto.
import * as NodeCrypto from "node:crypto";
import {
  AutomationError,
  AutomationId,
  AutomationRunId,
  ProvisionRequestId,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationSaveResult,
  type AutomationTrigger,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EnvironmentControl } from "../environmentControl/EnvironmentControl.ts";
import { createProvisionedLeaseRegistry } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { derivedRunId, makeAutomationRunner } from "./AutomationRunner.ts";
import { AutomationStore, type StoredAutomation, type StoredRun } from "./AutomationStore.ts";
import { dueCronSlot } from "./schedule.ts";

/** How often the scheduler looks for owed cron slots. Cron has minute resolution. */
export const SCHEDULER_TICK = Duration.seconds(30);
/** Webhook runs one automation may start per rolling hour before the link answers 429. */
const WEBHOOK_RUNS_PER_HOUR = 20;
/** How much of a webhook request body reaches the prompt. */
const WEBHOOK_CONTEXT_BYTES = 16 * 1024;

export type WebhookOutcome =
  | { readonly kind: "started"; readonly run: AutomationRun }
  | { readonly kind: "not-found" }
  | { readonly kind: "disabled" }
  | { readonly kind: "rate-limited" };

export interface WebhookDelivery {
  readonly body: string;
  readonly contentType: string | undefined;
  /** A caller's id for this delivery. A redelivery with the same id resolves to the same run. */
  readonly deliveryId: string | undefined;
}

/** Runs a recorded run to its end. The service owns when; this owns how. */
export type RunAutomation = (
  automation: Automation,
  run: StoredRun,
) => Effect.Effect<unknown, AutomationError>;

const hashWebhookToken = (token: string) =>
  NodeCrypto.createHash("sha256").update(token).digest("hex");

const toWire = ({ prompt: _prompt, ...run }: StoredRun): AutomationRun => run;

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
      // @effect-diagnostics-next-line preferSchemaOverJson:off - only re-indents an opaque payload.
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

export const makeAutomations = Effect.fn("makeAutomations")(function* (
  runAutomation: RunAutomation,
) {
  const store = yield* AutomationStore;
  const uuid = (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);
  const fibers = yield* FiberSet.make();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Runs a run in the background. Only a trigger that created the run and startup's resume
   * pass call this, so no run is launched twice in one process.
   */
  const launch = (automation: Automation, run: StoredRun) =>
    runAutomation(automation, run).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("automation run stopped", { runId: run.id, cause }),
      ),
      FiberSet.run(fibers),
      Effect.asVoid,
    );

  const trigger = Effect.fnUntraced(function* (
    automation: Automation,
    trigger: AutomationTrigger,
    options: {
      readonly requestKey: string | null;
      readonly scheduledFor: string | null;
      readonly prompt: string;
    },
  ) {
    const now = yield* nowIso;
    const requestId = ProvisionRequestId.make(
      options.requestKey === null ? yield* uuid : derivedRunId(automation.id, options.requestKey),
    );
    const { run, created } = yield* store.insertRun({
      id: AutomationRunId.make(yield* uuid),
      automationId: automation.id,
      trigger,
      scheduledFor: options.scheduledFor,
      requestId,
      prompt: options.prompt,
      state: "provisioning",
      environmentId: null,
      threadId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    // A repeated trigger lands on the run it already started. Resuming a run is startup's job.
    if (created) yield* launch(automation, run);
    return run;
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

  /** Fires each enabled automation's owed cron slot, at most one each. */
  const tick = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const { automation } of yield* store.list) {
      if (!automation.enabled || automation.schedule === null) continue;
      const slot = dueCronSlot(
        automation.schedule,
        automation.updatedAt,
        yield* store.lastCronSlot(automation.id),
        now,
      );
      if (slot === null) continue;
      yield* trigger(automation, "cron", {
        requestKey: `cron:${slot}`,
        scheduledFor: slot,
        prompt: automation.prompt,
      });
    }
  });

  /** Picks up runs a restart interrupted, then keeps the schedule. */
  const start = Effect.gen(function* () {
    const automations = new Map(
      (yield* store.list).map(({ automation }) => [automation.id, automation]),
    );
    for (const run of yield* store.unfinishedRuns) {
      const automation = automations.get(run.automationId);
      if (automation) yield* launch(automation, run);
    }
    yield* tick.pipe(
      Effect.catchCause((cause) => Effect.logError("automation scheduler tick failed", { cause })),
      Effect.repeat(Schedule.spaced(SCHEDULER_TICK)),
    );
  });

  return {
    start,
    tick,
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
      };
      yield* store.save(stored);
      return saved(stored, secret?.token ?? null);
    }),
    update: Effect.fn("Automations.update")(function* (id: AutomationId, input: AutomationInput) {
      const current = yield* load(id);
      // Turning the webhook on mints a link; leaving it on keeps the one already handed out.
      const secret = input.webhook && current.webhookSecretHash === null ? mintSecret() : null;
      const stored: StoredAutomation = {
        automation: { ...current.automation, ...input, updatedAt: yield* nowIso },
        webhookSecretHash: secret?.hash ?? current.webhookSecretHash,
      };
      yield* store.save(stored);
      return saved(stored, secret?.token ?? null);
    }),
    remove: (id: AutomationId) => store.remove(id),
    rotateWebhook: Effect.fn("Automations.rotateWebhook")(function* (id: AutomationId) {
      const current = yield* load(id);
      if (!current.automation.webhook)
        return yield* invalid("Turn the webhook on before rotating its link.");
      const secret = mintSecret();
      const stored: StoredAutomation = {
        automation: { ...current.automation, updatedAt: yield* nowIso },
        webhookSecretHash: secret.hash,
      };
      yield* store.save(stored);
      return saved(stored, secret.token);
    }),
    runNow: Effect.fn("Automations.runNow")(function* (id: AutomationId) {
      const { automation } = yield* load(id);
      return toWire(
        yield* trigger(automation, "manual", {
          requestKey: null,
          scheduledFor: null,
          prompt: automation.prompt,
        }),
      );
    }),
    listRuns: (id: AutomationId) =>
      store.listRuns(id, 50).pipe(Effect.map((runs) => runs.map(toWire))),
    webhook: Effect.fn("Automations.webhook")(function* (
      token: string,
      delivery: WebhookDelivery,
    ): Effect.fn.Return<WebhookOutcome, AutomationError> {
      const found = yield* store.byWebhookHash(hashWebhookToken(token));
      if (Option.isNone(found)) return { kind: "not-found" };
      const { automation } = found.value;
      if (!automation.enabled) return { kind: "disabled" };
      const hourAgo = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
      if ((yield* store.countRunsSince(automation.id, "webhook", hourAgo)) >= WEBHOOK_RUNS_PER_HOUR)
        return { kind: "rate-limited" };
      const run = yield* trigger(automation, "webhook", {
        requestKey: delivery.deliveryId === undefined ? null : `webhook:${delivery.deliveryId}`,
        scheduledFor: null,
        prompt: webhookPrompt(automation.prompt, delivery),
      });
      return { kind: "started", run: toWire(run) };
    }),
  };
});

export class Automations extends Context.Service<
  Automations,
  Omit<Effect.Success<ReturnType<typeof makeAutomations>>, "start" | "tick">
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
      const automations = yield* makeAutomations((automation, run) =>
        runner(automation, run).pipe(Effect.provide(context)),
      );
      yield* forkParked(automations.start);
      return automations;
    }),
  ).pipe(Layer.provide(AutomationStore.layer));
}
