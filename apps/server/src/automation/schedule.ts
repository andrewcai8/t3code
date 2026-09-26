import { parseAutomationCron, type AutomationSchedule } from "@t3tools/contracts";
import * as Cron from "effect/Cron";

/**
 * The cron slot an automation owes a run at `now`, or null when it owes none.
 *
 * Only the latest slot at or before `now` is considered, so a host that was down across several
 * slots runs once on its return rather than once per slot. A slot at or before `since` (the
 * schedule last changed) or `lastSlot` (the latest slot already run) is not owed.
 */
export function dueCronSlot(
  schedule: AutomationSchedule,
  since: string,
  lastSlot: string | null,
  now: number,
): string | null {
  const cron = parseAutomationCron(schedule.cron, schedule.timeZone);
  if (!cron) return null;
  const latest = Cron.prev(cron, now + 1).getTime();
  const floor = Math.max(Date.parse(since), lastSlot === null ? -Infinity : Date.parse(lastSlot));
  return latest > floor ? new Date(latest).toISOString() : null;
}
