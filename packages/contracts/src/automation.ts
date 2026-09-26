import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProvisionProvider,
  ProvisionRequestId,
  type DiscoveredProvisionedEnvironment,
} from "./environmentControl.ts";
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

/** Each run starts a paid machine, so a schedule may fire at most this often. */
const AUTOMATION_MIN_INTERVAL_MINUTES = 15;

/**
 * The shortest gap, in minutes, between two firings. Only the minute and hour fields can put
 * firings closer than an hour apart, and an empty set is the wildcard. Hour 23 is treated as
 * next to hour 0, which can only overstate how close firings get.
 */
function automationCronMinGapMinutes(cron: Cron.Cron): number {
  const minutes =
    cron.minutes.size === 0
      ? Array.from({ length: 60 }, (_, minute) => minute)
      : [...cron.minutes].sort((left, right) => left - right);
  const hours = cron.hours.size === 0 ? null : cron.hours;
  const adjacentHours = hours === null || [...hours].some((hour) => hours.has((hour + 1) % 24));
  const gaps = minutes.slice(1).map((minute, index) => minute - minutes[index]!);
  if (adjacentHours) gaps.push(60 - minutes.at(-1)! + minutes[0]!);
  return gaps.length === 0 ? Infinity : Math.min(...gaps);
}

export const AutomationSchedule = Schema.Struct({
  cron: TrimmedNonEmptyString,
  /** IANA zone the cron expression is read in, such as `America/New_York`. */
  timeZone: TrimmedNonEmptyString,
}).check(
  Schema.makeFilter(({ cron, timeZone }) => {
    const parsed = parseAutomationCron(cron, timeZone);
    if (parsed === null) return "Use a five-field cron expression and an IANA time zone.";
    return (
      automationCronMinGapMinutes(parsed) >= AUTOMATION_MIN_INTERVAL_MINUTES ||
      `Runs must be at least ${AUTOMATION_MIN_INTERVAL_MINUTES} minutes apart.`
    );
  }),
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
 * once `started`. A trigger that arrives while another run is still in flight
 * is recorded as `skipped` and starts nothing.
 */
export const AutomationRunState = Schema.Literals([
  "provisioning",
  "attaching",
  "starting",
  "started",
  "failed",
  "skipped",
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
  /** When a failed run's machine was disposed. Null while it exists or never did. */
  disposedAt: Schema.NullOr(IsoDateTime),
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

/** Newest runs first. `limit` defaults to, and is capped at, 50. */
export const AutomationListRunsInput = Schema.Struct({
  id: AutomationId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type AutomationListRunsInput = typeof AutomationListRunsInput.Type;

/** How far back, and how many, automation runs a client joins without being asked. */
const AUTOMATION_JOIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTOMATION_JOIN_LIMIT = 10;

/**
 * The automation-run environments worth joining unasked: active (a paused box stays paused),
 * started within the join window, newest first, at most `AUTOMATION_JOIN_LIMIT`. Older or
 * paused runs stay reachable from run history.
 */
export function recentAutomationEnvironments(
  discovered: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  now: number,
): ReadonlyArray<DiscoveredProvisionedEnvironment> {
  return discovered
    .filter(
      (environment) =>
        environment.automationId !== undefined &&
        environment.lifecycle === "active" &&
        Date.parse(environment.createdAt) >= now - AUTOMATION_JOIN_WINDOW_MS,
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, AUTOMATION_JOIN_LIMIT);
}

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}
