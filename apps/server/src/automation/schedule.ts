// @effect-diagnostics globalDate:off - cron slots are compared as epoch millis at a pure boundary.
import { parseAutomationCron, type AutomationSchedule } from "@t3tools/contracts";
import * as Cron from "effect/Cron";

/** A host down longer than this does not run the slots it missed. */
const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A 15-minute schedule has 672 slots a week; this bounds a pathological one. */
const MAX_STEPS = 2_000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The cron slot an automation owes a run at `now`, or null when it owes none.
 *
 * Only the latest slot at or before `now` is owed, so a host that was down across several slots
 * runs once on its return rather than once per slot. A slot at or before `since` (the schedule
 * started counting) or `lastSlot` (the latest slot already recorded) is not owed.
 *
 * Slots are found by stepping `Cron.next` forward. `Cron.prev` throws for about a day around a
 * spring-forward change when the slot falls in the skipped hour; `next` maps that slot to the
 * first instant after the gap. A step that still throws skips an hour ahead.
 */
export function dueCronSlot(
  schedule: AutomationSchedule,
  since: string,
  lastSlot: string | null,
  now: number,
): string | null {
  const cron = parseAutomationCron(schedule.cron, schedule.timeZone);
  if (!cron) return null;
  let cursor = Math.max(
    Date.parse(since),
    lastSlot === null ? -Infinity : Date.parse(lastSlot),
    now - CATCH_UP_WINDOW_MS,
  );
  let owed: number | null = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    let next: number;
    try {
      next = Cron.next(cron, cursor).getTime();
    } catch {
      cursor += HOUR_MS;
      continue;
    }
    if (next > now) break;
    owed = next;
    cursor = next;
  }
  return owed === null ? null : new Date(owed).toISOString();
}
