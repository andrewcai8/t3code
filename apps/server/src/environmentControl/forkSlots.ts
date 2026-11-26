import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * How long a job keeps its place while E2B refuses its copy for want of room: an account at its
 * running-sandbox limit, or a placement that failed for the moment. Each refusal leaves nothing
 * running, and the waits grow to a minute apart.
 */
export const NO_ROOM_RETRY = Schedule.min([
  Schedule.exponential("5 seconds"),
  Schedule.spaced("1 minute"),
]).pipe(Schedule.upTo({ duration: "15 minutes" }));
/** Machines wake and pause without telling this host, so a job waiting for E2B room counts again. */
const E2B_RECOUNT = Duration.seconds(30);

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
    /**
     * Runs `effect` at once in a slot over capacity, so what already runs is counted whatever the
     * size is now; waiters get a slot only once the count falls below it.
     */
    withSlotNow: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          used += 1;
          return restore(effect).pipe(Effect.ensuring(Effect.sync(free)));
        }),
      ),
    /**
     * `whileWaiting` runs only until the slot is handed over, as a way to learn of a resize, or
     * to give up by failing.
     */
    withSlot: <A, E, R, EW = never>(
      effect: Effect.Effect<A, E, R>,
      whileWaiting: Effect.Effect<never, EW> = Effect.never,
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
            Effect.onError(() =>
              Effect.sync(() => {
                if (!waiting.delete(turn)) free();
              }),
            ),
          );
        }).pipe(Effect.andThen(restore(effect).pipe(Effect.ensuring(Effect.sync(free))))),
      ),
  };
};

export type Slots = ReturnType<typeof makeSlots>;

/**
 * Runs `effect` in its turn for one of `slots`, sized to what the E2B account has left once every
 * sandbox that is not this host's copy is counted (`sizeFor`), and counted again while it waits.
 * Null from `countOthers` is a provider whose copies share no limit, so `effect` runs at once; a
 * count that fails leaves the size as it was.
 */
export const withSharedRoom = <A, E, R, CE, ET = never>(
  slots: Slots,
  sizeFor: (others: number) => number,
  countOthers: Effect.Effect<number | null, CE>,
  effect: Effect.Effect<A, E, R>,
  limit?: { readonly after: Duration.Input; readonly fail: ET },
) => {
  // The count logs its own failure, once per listing rather than once per waiter.
  const recount = countOthers.pipe(
    Effect.flatMap((others) =>
      others === null ? Effect.succeed(false) : slots.resize(sizeFor(others)).pipe(Effect.as(true)),
    ),
    Effect.orElseSucceed(() => true),
  );
  const recounting = Effect.forever(Effect.sleep(E2B_RECOUNT).pipe(Effect.andThen(recount)));
  const waiting: Effect.Effect<never, ET> =
    limit === undefined
      ? recounting
      : recounting.pipe(
          Effect.timeoutOrElse({ duration: limit.after, orElse: () => Effect.fail(limit.fail) }),
        );
  return recount.pipe(
    Effect.flatMap((shared) => (shared ? slots.withSlot(effect, waiting) : effect)),
  );
};
