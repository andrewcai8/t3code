// @effect-diagnostics globalDate:off - cleanup times are ISO timestamps compared with the caller's clock.
import type { ProvisionedCleanup } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function removedIn(remainingMs: number, resolve: MFunctionType): string {
  if (remainingMs <= 0) return resolve(msg("Removed soon"));
  if (remainingMs < HOUR_MS) {
    return resolve(
      msg("Removed in {minutes} min", { minutes: Math.ceil(remainingMs / MINUTE_MS) }),
    );
  }
  if (remainingMs < DAY_MS) {
    return resolve(
      msg("{count, plural, one {Removed in {count} hour} other {Removed in {count} hours}}", {
        count: Math.round(remainingMs / HOUR_MS),
      }),
    );
  }
  return resolve(
    msg("{count, plural, one {Removed in {count} day} other {Removed in {count} days}}", {
      count: Math.round(remainingMs / DAY_MS),
    }),
  );
}

/**
 * How a cloud machine's automatic cleanup reads in a list, and the one action it offers: keep a
 * machine that is scheduled for removal, or allow cleanup of one the user kept. Null for a machine
 * that is never cleaned up.
 */
export function describeCloudCleanup(
  cleanup: ProvisionedCleanup | undefined,
  now: number,
  resolve: MFunctionType = mFallback,
): { readonly text: string; readonly action: "keep" | "allow" | null } | null {
  if (cleanup === undefined) return null;
  if (cleanup.kind === "kept")
    return cleanup.reason === "user"
      ? {
          text: resolve(msg("Kept", { $context: "cloud machine exempt from cleanup" })),
          action: "allow",
        }
      : { text: resolve(msg("Kept · work could not be backed up")), action: null };
  const text = removedIn(Date.parse(cleanup.at) - now, resolve);
  return {
    text:
      cleanup.reason === "settled" ? resolve(msg("Settled · {removal}", { removal: text })) : text,
    action: "keep",
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long a removed cloud machine can still be brought back, as its row and banner say it. Null
 * for a machine that cannot be restored, or once its grace has ended.
 */
export function describeRestorable(
  restorableUntil: string | null | undefined,
  now: number,
  resolve: MFunctionType = mFallback,
): string | null {
  if (!restorableUntil) return null;
  const until = new Date(restorableUntil);
  if (!(until.getTime() > now)) return null;
  return resolve(
    msg("Restorable until {month} {day}", {
      month: MONTHS[until.getMonth()],
      day: until.getDate(),
    }),
  );
}
