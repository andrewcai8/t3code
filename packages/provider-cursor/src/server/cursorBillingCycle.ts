import type { ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * Give each Cursor pool the billing cycle's length as its window. Account
 * routing paces a pool's refill against it; without one it assumes a
 * five-hour horizon, which a monthly pool never refills within.
 */
export function withCursorBillingCycle(
  limits: ServerProviderUsageLimits,
  cycle: {
    readonly billingCycleStart?: string | number | undefined;
    readonly billingCycleEnd?: string | number | undefined;
  },
): ServerProviderUsageLimits {
  const start = Number(cycle.billingCycleStart);
  const end = Number(cycle.billingCycleEnd);
  if (!(start > 0 && end > start)) return limits;
  const windowDurationMins = Math.round((end - start) / 60_000);
  return {
    ...limits,
    windows: limits.windows.map((window) => ({ ...window, windowDurationMins })),
  };
}
