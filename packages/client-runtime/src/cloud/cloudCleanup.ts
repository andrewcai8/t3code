// @effect-diagnostics globalDate:off - cleanup times are ISO timestamps compared with the caller's clock.
import type { ProvisionedCleanup } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

function removedIn(remainingMs: number): string {
  if (remainingMs <= 0) return "Removed soon";
  if (remainingMs < HOUR_MS) return `Removed in ${Math.ceil(remainingMs / MINUTE_MS)} min`;
  if (remainingMs < DAY_MS)
    return `Removed in ${plural(Math.round(remainingMs / HOUR_MS), "hour")}`;
  return `Removed in ${plural(Math.round(remainingMs / DAY_MS), "day")}`;
}

/**
 * How a cloud machine's automatic cleanup reads in a list, and the one action it offers: keep a
 * machine that is scheduled for removal, or allow cleanup of one the user kept. Null for a machine
 * that is never cleaned up.
 */
export function describeCloudCleanup(
  cleanup: ProvisionedCleanup | undefined,
  now: number,
): { readonly text: string; readonly action: "keep" | "allow" | null } | null {
  if (cleanup === undefined) return null;
  if (cleanup.kind === "kept")
    return cleanup.reason === "user"
      ? { text: "Kept", action: "allow" }
      : { text: "Kept · work could not be backed up", action: null };
  const text = removedIn(Date.parse(cleanup.at) - now);
  return { text: cleanup.reason === "settled" ? `Settled · ${text}` : text, action: "keep" };
}
