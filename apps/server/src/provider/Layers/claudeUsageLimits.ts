/**
 * Claude Code subscription usage. Both sources produce windows with the same
 * ids so a turn-driven `rate_limit_event` lands on the row the SDK's
 * `get_usage` read established:
 *
 * - `get_usage` (on demand, during the capabilities probe) reports every
 *   window at once as 0–100 percentages with ISO reset times. It needs the
 *   login's profile scope, which a `claude setup-token` token lacks.
 * - `rate_limit_event` (streamed during a turn) carries 0–1 utilization
 *   fractions and epoch-seconds resets: every window under `unifiedWindows`,
 *   or on older CLIs the one window `rateLimitType` names. A setup-token
 *   account gets its windows from this alone.
 *
 * @module provider/Layers/claudeUsageLimits
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/**
 * The account-wide windows, keyed by the SDK's `rateLimitType`. Model-scoped
 * weeklies are additive on top of these: the CLI reports them under
 * `rate_limits.model_scoped[]` on `get_usage` and streams the overage-included
 * model bucket (Fable today) as `seven_day_overage_included`.
 */
const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `unifiedWindows` is marked internal in the CLI and missing from the SDK
 * typings, so it is parsed rather than trusted.
 */
const UnifiedWindow = Schema.Struct({ utilization: Schema.Finite, resetsAt: Schema.Finite });
const decodeUnifiedWindows = Schema.decodeUnknownOption(
  Schema.Struct({
    five_hour: Schema.optional(UnifiedWindow),
    seven_day: Schema.optional(UnifiedWindow),
    [OVERAGE_INCLUDED_EVENT_TYPE]: Schema.optional(UnifiedWindow),
  }),
);

function eventWindow(
  type: string,
  utilization: number,
  resetsAtSeconds: number | undefined,
  names: ClaudeScopedLimitNames,
): ServerProviderUsageWindow | undefined {
  const usedPercent = utilization * 100;
  const resetsAt = isoFromEpochSeconds(resetsAtSeconds);
  if (type in WINDOWS) return makeWindow(type, usedPercent, resetsAt);
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return scopedWindow(names.overageIncluded, usedPercent, resetsAt);
  }
  return undefined;
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * window before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
function claudeRateLimitEventWindows(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ReadonlyArray<ServerProviderUsageWindow> {
  const unified = decodeUnifiedWindows(
    (info as { readonly unifiedWindows?: unknown }).unifiedWindows,
  );
  const windows = Option.isSome(unified)
    ? Object.entries(unified.value).flatMap(([type, window]) => {
        const mapped = window && eventWindow(type, window.utilization, window.resetsAt, names);
        return mapped ? [mapped] : [];
      })
    : [];
  if (windows.length > 0) return windows;
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") return [];
  const mapped = eventWindow(type, info.utilization, info.resetsAt, names);
  return mapped ? [mapped] : [];
}

export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const windows = claudeRateLimitEventWindows(info, names);
  return windows.length > 0 ? { windows } : undefined;
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    // Only a bucket that drew a row may receive events; naming one that was
    // skipped would let a mid-turn event open a row the probe never showed.
    overageIncluded ??= entry.display_name;
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

/**
 * One read of an account's windows. `get_usage` answers for any login with
 * profile scope. A setup-token account instead runs a one-word turn and
 * reports the `rate_limit_event` that came back with it, or none when the
 * turn failed. Those turns are rationed (see `makeClaudeUsageTurnReader`);
 * `recentTurn` means one ran recently, so there is nothing new to publish and
 * the windows it and later real turns established stand.
 */
export type ClaudeUsageRead =
  | {
      readonly source: "usageEndpoint";
      readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
    }
  | { readonly source: "rateLimitEvent"; readonly info: SDKRateLimitInfo | undefined }
  | { readonly source: "recentTurn" };

/**
 * Only `get_usage` names the scoped buckets, so a turn-derived read keeps
 * the names already known. A turn that reported no window this build can
 * draw is a failed read, not an account without limits. `recentTurn` yields
 * no limits, which callers publish as "usage unchanged".
 */
export function claudeUsageReadToLimits(input: {
  readonly read: ClaudeUsageRead;
  readonly names: ClaudeScopedLimitNames;
  readonly checkedAt: string;
}): {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly names: ClaudeScopedLimitNames;
} {
  const { read, names, checkedAt } = input;
  if (read.source === "usageEndpoint") {
    return claudeUsageResponseToLimits({ response: read.response, checkedAt });
  }
  if (read.source === "recentTurn") return { limits: undefined, names };
  const windows = read.info ? claudeRateLimitEventWindows(read.info, names) : [];
  return {
    limits:
      windows.length > 0
        ? makeUsageLimits({ checkedAt, windows })
        : makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Claude did not report usage windows.",
          }),
    names,
  };
}

/** Probe-side helper: map the read and remember the scoped names for events. */
export const recordClaudeUsageRead = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: { readonly read: ClaudeUsageRead; readonly checkedAt: string },
): Effect.Effect<ServerProviderUsageLimits | undefined> =>
  Ref.modify(namesRef, (names) => {
    const mapped = claudeUsageReadToLimits({ ...input, names });
    return [mapped.limits, mapped.names];
  });
