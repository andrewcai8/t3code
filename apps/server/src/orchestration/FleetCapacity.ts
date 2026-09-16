/**
 * Which account can take the next turn.
 *
 * A fleet of accounts is only as useful as the scheduler's ability to tell a
 * live one from a spent one, and session status cannot: a Cursor account with
 * no subscription left still answers, `ready`, with the words "Upgrade your
 * plan to continue". Routing on that signal feeds work to dead accounts and
 * collects prose instead of results.
 *
 * Providers already report the real answer. Each account carries usage windows
 * with a `usedPercent`, and across every account observed, `usedPercent < 100`
 * predicted a working turn and `100` predicted a refusal. This module turns
 * those windows into a routing decision, as a pure function so the rule can be
 * argued with in a test rather than discovered in production.
 */

/** A provider-reported usage window, narrowed to what routing needs. */
export interface UsageWindow {
  readonly id: string;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
}

export interface Lane {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  /** Absent when the provider has not reported usage yet. */
  readonly windows: readonly UsageWindow[] | undefined;
}

export type LaneCapacity =
  | {
      readonly kind: "available";
      readonly headroomPercent: number;
      readonly limitingWindow: string;
    }
  | {
      readonly kind: "exhausted";
      readonly windowId: string;
      readonly resetsAt?: string | undefined;
    }
  | { readonly kind: "unusable"; readonly reason: "disabled" | "capacity-unknown" };

/**
 * Model families that get their own weekly window. A window naming one of
 * these constrains only that family: Claude reports `seven_day_fable` at 100%
 * while `five_hour` sits at 10%, and an Opus turn on that account succeeds.
 */
const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

/** The family a window is scoped to, or `null` when it constrains everything. */
function windowFamily(windowId: string): string | null {
  return MODEL_FAMILIES.find((family) => windowId.endsWith(`_${family}`)) ?? null;
}

/** The family a model belongs to, or `null` when it names none. */
function modelFamily(model: string): string | null {
  const lowered = model.toLowerCase();
  return MODEL_FAMILIES.find((family) => lowered.includes(family)) ?? null;
}

/**
 * Whether a window constrains a turn on `model`.
 *
 * `cursor_api` is excluded deliberately. It reports the pay-per-use API
 * channel, which subscription models do not draw on: the `cursor` account
 * answered a `composer-2.5` turn while that window read 100%. Gating on it
 * would park three working accounts.
 */
export function windowGates(windowId: string, model: string): boolean {
  if (windowId === "cursor_api") return false;
  const family = windowFamily(windowId);
  return family === null || family === modelFamily(model);
}

const EXHAUSTED_AT = 100;

/** What a lane can do for `model` right now. */
export function laneCapacity(lane: Lane, model: string): LaneCapacity {
  if (!lane.enabled) return { kind: "unusable", reason: "disabled" };
  const windows = lane.windows;
  // No windows means the provider has not answered yet. Reporting that as
  // available would route real work at a guess; naming it lets a caller wait.
  if (windows === undefined || windows.length === 0)
    return { kind: "unusable", reason: "capacity-unknown" };

  const gating = windows.filter((window) => windowGates(window.id, model));
  if (gating.length === 0) return { kind: "unusable", reason: "capacity-unknown" };

  const spent = gating.find((window) => window.usedPercent >= EXHAUSTED_AT);
  if (spent) return { kind: "exhausted", windowId: spent.id, resetsAt: spent.resetsAt };

  // The tightest window is the one that will stop this lane first, so it is
  // the honest measure of how much room is actually left.
  const limiting = gating.reduce((tightest, window) =>
    window.usedPercent > tightest.usedPercent ? window : tightest,
  );
  return {
    kind: "available",
    headroomPercent: EXHAUSTED_AT - limiting.usedPercent,
    limitingWindow: limiting.id,
  };
}

export interface RankedLane {
  readonly instanceId: string;
  readonly headroomPercent: number;
  readonly limitingWindow: string;
}

/**
 * Lanes that can take `model` now, most headroom first.
 *
 * Spreading work toward the emptiest account keeps any single one from being
 * driven to its limit while others idle, which is what turns a pile of
 * accounts into parallel capacity.
 */
export function rankLanes(lanes: readonly Lane[], model: string): readonly RankedLane[] {
  return lanes
    .flatMap((lane) => {
      const capacity = laneCapacity(lane, model);
      return capacity.kind === "available"
        ? [
            {
              instanceId: lane.instanceId,
              headroomPercent: capacity.headroomPercent,
              limitingWindow: capacity.limitingWindow,
            },
          ]
        : [];
    })
    .sort(
      (a, b) => b.headroomPercent - a.headroomPercent || a.instanceId.localeCompare(b.instanceId),
    );
}
