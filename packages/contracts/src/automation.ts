import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProvisionProvider, ProvisionRequestId } from "./environmentControl.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const AutomationId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationId"));
export type AutomationId = typeof AutomationId.Type;
export const AutomationRunId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationRunId"));
export type AutomationRunId = typeof AutomationRunId.Type;

/** A webhook link is `<host origin><prefix>/<token>`. The token is the whole credential. */
export const AUTOMATION_WEBHOOK_PATH_PREFIX = "/api/automations/hooks";

/** Parses a five-field cron expression in `timeZone`; seconds are not schedulable. */
export function parseAutomationCron(cron: string, timeZone: string) {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  return Result.getOrNull(Cron.parse(cron, timeZone));
}

export const AutomationSchedule = Schema.Struct({
  cron: TrimmedNonEmptyString,
  /** IANA zone the cron expression is read in, such as `America/New_York`. */
  timeZone: TrimmedNonEmptyString,
}).check(
  Schema.makeFilter(
    ({ cron, timeZone }) =>
      parseAutomationCron(cron, timeZone) !== null ||
      "Use a five-field cron expression and an IANA time zone.",
  ),
);
export type AutomationSchedule = typeof AutomationSchedule.Type;

/** What a user sets when creating or editing an automation. */
export const AutomationInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** `owner/name`. */
  repository: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  agentDriver: ProviderDriverKind,
  /** The account every run uses. Null runs each on the account with the most usage left. */
  account: Schema.NullOr(ProviderInstanceId),
  provider: ProvisionProvider,
  /** Null runs only from the webhook or Run now. */
  schedule: Schema.NullOr(AutomationSchedule),
  webhook: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type AutomationInput = typeof AutomationInput.Type;

export const Automation = Schema.Struct({
  id: AutomationId,
  ...AutomationInput.fields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Automation = typeof Automation.Type;

export const AutomationTrigger = Schema.Literals(["cron", "webhook", "manual"]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

/**
 * A run moves `provisioning → attaching → starting → started`, or to `failed`
 * from any of those. `environmentId` is known from `starting` on, `threadId`
 * once `started`.
 */
export const AutomationRunState = Schema.Literals([
  "provisioning",
  "attaching",
  "starting",
  "started",
  "failed",
]);
export type AutomationRunState = typeof AutomationRunState.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  trigger: AutomationTrigger,
  scheduledFor: Schema.NullOr(IsoDateTime),
  requestId: ProvisionRequestId,
  state: AutomationRunState,
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutomationRun = typeof AutomationRun.Type;

/** `webhookToken` is set only when a secret was just minted; the host keeps its hash alone. */
export const AutomationSaveResult = Schema.Struct({
  automation: Automation,
  webhookToken: Schema.NullOr(Schema.String),
});
export type AutomationSaveResult = typeof AutomationSaveResult.Type;

export const AutomationUpdateInput = Schema.Struct({
  id: AutomationId,
  automation: AutomationInput,
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationIdInput = Schema.Struct({ id: AutomationId });
export type AutomationIdInput = typeof AutomationIdInput.Type;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}
