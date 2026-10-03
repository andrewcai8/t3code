// @effect-diagnostics nodeBuiltinImport:off - sizes the pool from the host's CPU count.
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Permits shared by every provider instance in the process, one per running
 * status check. Boot, interval, and manual refreshes queue here in arrival
 * order, so a host with many instances runs a few probes at a time instead of
 * all of them at once.
 */
export const ProviderCheckPermits = Context.Reference<Semaphore.Semaphore>(
  "@t3tools/server/provider/ProviderCheckPermits",
  { defaultValue: () => Semaphore.makeUnsafe(Math.max(4, NodeOS.availableParallelism())) },
);

/**
 * Run one status check once it holds a permit. Provider timeouts live inside
 * the check, so time spent waiting in line never counts against them.
 */
export const withProviderCheckPermit = <A, E, R>(
  check: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const permits = yield* ProviderCheckPermits;
    return yield* permits.withPermits(1)(check);
  });
