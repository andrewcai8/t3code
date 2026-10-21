import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * Slots handed out first come, first served. Effect's Semaphore wakes its waiters on a later tick,
 * so a batch that frees a slot and asks again at once keeps it ahead of another batch's job that
 * was already waiting. Here a freed slot goes straight to the oldest waiter. Waiting can always be
 * interrupted, even where the work itself cannot be, so a host shutting down never waits its turn.
 */
export const makeSlots = (initial: number) => {
  let size = initial;
  let used = 0;
  const waiting = new Set<Deferred.Deferred<void>>();
  const handOut = () => {
    for (const turn of waiting) {
      if (used >= size) return;
      waiting.delete(turn);
      used += 1;
      Deferred.doneUnsafe(turn, Effect.void);
    }
  };
  const free = () => {
    used -= 1;
    handOut();
  };
  return {
    resize: (next: number) =>
      Effect.sync(() => {
        size = next;
        handOut();
      }),
    /** `whileWaiting` runs only until the slot is handed over, as a way to learn of a resize. */
    withSlot: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      whileWaiting: Effect.Effect<never> = Effect.never,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (waiting.size === 0 && used < size) {
            used += 1;
            return Effect.void;
          }
          const turn = Deferred.makeUnsafe<void>();
          waiting.add(turn);
          // A slot handed over just as the wait is interrupted goes to the next waiter.
          return Effect.interruptible(Effect.raceFirst(Deferred.await(turn), whileWaiting)).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                if (!waiting.delete(turn)) free();
              }),
            ),
          );
        }).pipe(Effect.andThen(restore(effect).pipe(Effect.ensuring(Effect.sync(free))))),
      ),
  };
};
