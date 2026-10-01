import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeUserPresence } from "./presence.ts";

const harness = Effect.fn("presenceHarness")(function* () {
  const visible = yield* Queue.unbounded<boolean>();
  const inputs = yield* Queue.unbounded<void>();
  const presence = yield* makeUserPresence({
    visible: Stream.fromQueue(visible),
    inputs: Stream.fromQueue(inputs),
  });
  const present = Effect.fn("present")(function* () {
    yield* Effect.yieldNow;
    return Option.getOrThrow(yield* Stream.runHead(presence.present));
  });
  return { visible, inputs, present };
});

describe("user presence", () => {
  it.effect("is here while the app is on screen and was touched within the hour", () =>
    Effect.gen(function* () {
      const { visible, inputs, present } = yield* harness();
      yield* Queue.offer(visible, true);
      expect(yield* present()).toBe(true);

      yield* TestClock.adjust("59 minutes");
      expect(yield* present()).toBe(true);
      yield* Queue.offer(inputs, undefined);
      yield* TestClock.adjust("59 minutes");
      expect(yield* present()).toBe(true);

      yield* TestClock.adjust("2 minutes");
      expect(yield* present()).toBe(false);
      yield* Queue.offer(inputs, undefined);
      expect(yield* present()).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("is away while the app is hidden, whatever the input", () =>
    Effect.gen(function* () {
      const { visible, inputs, present } = yield* harness();
      yield* Queue.offer(visible, true);
      yield* Queue.offer(visible, false);
      yield* Queue.offer(inputs, undefined);
      expect(yield* present()).toBe(false);

      yield* Queue.offer(visible, true);
      expect(yield* present()).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
