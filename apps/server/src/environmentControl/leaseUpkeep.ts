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
 * How often each awake instance-engine chat is checked against its Mac's deadline. Its saves keep
 * their own five-minute cadence; this only bounds how late a deadline is noticed.
 */
const CHAT_UPKEEP_INTERVAL = Duration.minutes(1);

/**
 * The manager's background upkeep. Pausing expired leases and collecting box
 * usage repeat as separate loops, so boxes slow to report usage never delay a
 * pause. A failed step is logged and retried on the next tick, and never skips
 * another step or stops the other loop.
 */
export const runLeaseUpkeep = (input: {
  readonly reapExpiredLeases: () => Promise<void>;
  readonly syncLeaseUsage: () => Promise<void>;
  /** Periodic saves and deadline releases of instance-engine chats. */
  readonly upkeepCloudChats?: () => Promise<void>;
  readonly reconcileProvisions: Effect.Effect<void, ProvisionStoreError>;
  /** Starts each awake box's pending first turn. Never fails. */
  readonly settleChats: Effect.Effect<void>;
  readonly boxUsage: Pick<BoxUsageStore["Service"], "prune">;
}) => {
  const repeat = (tick: Effect.Effect<void>) =>
    tick.pipe(
      Effect.catchDefect((cause) => Effect.logError("cloud lease upkeep failed", { cause })),
      Effect.repeat(Schedule.spaced(LEASE_UPKEEP_INTERVAL)),
    );
  const reap = Effect.gen(function* () {
    // First, so a box whose chat's first turn is still pending gets it before any pause check.
    yield* input.settleChats;
    // A lease is only registered once its provision reached ready, so an
    // expired heartbeat means a finished machine nobody is watching. Pause
    // it and leave it reconnectable. A provision that never reached ready
    // holds no lease; reconciling below resumes or disposes it.
    yield* Effect.tryPromise(input.reapExpiredLeases).pipe(
      Effect.ignore({ log: "Warn", message: "expired cloud leases could not be paused" }),
    );
    // A restart or a stalled step leaves an unfinished provision that no
    // caller will come back for.
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
  // Started, not awaited: each chat's pass runs on its own and a slow one never delays the tick.
  const upkeepChats = Effect.sync(() => {
    void input.upkeepCloudChats?.().catch(() => undefined);
  }).pipe(Effect.repeat(Schedule.spaced(CHAT_UPKEEP_INTERVAL)));
  return Effect.all([repeat(reap), repeat(collectUsage), upkeepChats], {
    concurrency: 3,
    discard: true,
  });
};
