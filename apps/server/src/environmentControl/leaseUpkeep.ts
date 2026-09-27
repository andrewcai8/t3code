import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { BoxUsageStore } from "../usage/boxUsage.ts";
import { CACHE_RETENTION_DAYS } from "../usage/UsageService.ts";
import type { ProvisionStoreError } from "./ProvisionOperationStore.ts";

export const LEASE_UPKEEP_INTERVAL = Duration.minutes(5);

/**
 * The manager's background upkeep. Pausing expired leases and collecting box
 * usage repeat as separate loops, so boxes slow to report usage never delay a
 * pause. A failed step is logged and retried on the next tick, and never skips
 * another step or stops the other loop.
 */
export const runLeaseUpkeep = (input: {
  readonly reapExpiredLeases: () => Promise<void>;
  readonly syncLeaseUsage: () => Promise<void>;
  readonly reconcileProvisions: Effect.Effect<void, ProvisionStoreError>;
  readonly boxUsage: Pick<BoxUsageStore["Service"], "prune">;
}) => {
  const repeat = (tick: Effect.Effect<void>) =>
    tick.pipe(
      Effect.catchDefect((cause) => Effect.logError("cloud lease upkeep failed", { cause })),
      Effect.repeat(Schedule.spaced(LEASE_UPKEEP_INTERVAL)),
    );
  const reap = Effect.gen(function* () {
    // A lease is only registered once its provision reached ready, so an
    // expired heartbeat means a finished machine nobody is watching. Pause
    // it and leave it reconnectable. A provision that never reached ready
    // holds no lease and is disposed by its retention deadline instead.
    yield* Effect.tryPromise(input.reapExpiredLeases).pipe(
      Effect.ignore({ log: "Warn", message: "expired cloud leases could not be paused" }),
    );
    // A crash between issuing an allocation and recording it leaves a
    // resource nobody else will look for.
    yield* input.reconcileProvisions.pipe(
      Effect.ignore({ log: "Warn", message: "provisions could not be reconciled" }),
    );
  });
  const collectUsage = Effect.gen(function* () {
    yield* Effect.tryPromise(input.syncLeaseUsage).pipe(
      Effect.ignore({ log: "Warn", message: "cloud box usage could not be collected" }),
    );
    const now = yield* Clock.currentTimeMillis;
    yield* input.boxUsage
      .prune(DateTime.formatIso(DateTime.makeUnsafe(now - CACHE_RETENTION_DAYS * 86_400_000)))
      .pipe(Effect.ignore({ log: "Warn", message: "old cloud box usage could not be pruned" }));
  });
  return Effect.all([repeat(reap), repeat(collectUsage)], { concurrency: 2, discard: true });
};
