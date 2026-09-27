import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { LEASE_UPKEEP_INTERVAL, runLeaseUpkeep } from "./leaseUpkeep.ts";

it.effect("keeps both loops ticking after a reap rejects and a reconcile dies", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<"reap" | "usage">();
    const upkeep = yield* runLeaseUpkeep({
      reapExpiredLeases: async () => {
        Queue.offerUnsafe(calls, "reap");
        throw new Error("lease registry is unreadable");
      },
      syncLeaseUsage: async () => {
        Queue.offerUnsafe(calls, "usage");
      },
      reconcileProvisions: Effect.die(new Error("reconcile bug")),
      boxUsage: { prune: () => Effect.void },
    }).pipe(Effect.forkScoped);
    // Upkeep never ends on its own, so an exit here fails the test with its cause.
    const nextTick = Effect.raceFirst(
      Queue.takeN(calls, 2).pipe(Effect.map((tick) => tick.toSorted())),
      Fiber.join(upkeep).pipe(Effect.as("upkeep stopped")),
    );

    const ticks = [yield* nextTick];
    for (const _ of [1, 2]) {
      yield* TestClock.adjust(LEASE_UPKEEP_INTERVAL);
      ticks.push(yield* nextTick);
    }

    assert.deepStrictEqual(ticks, [
      ["reap", "usage"],
      ["reap", "usage"],
      ["reap", "usage"],
    ]);
  }).pipe(Effect.scoped),
);
