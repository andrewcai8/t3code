import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** How long the user may leave the app untouched before they count as away. */
export const USER_AWAY_AFTER = Duration.minutes(60);

/**
 * Whether the user is here: the app is visible and they touched it within the last hour. A cloud
 * box is kept awake and woken only while its user is here, so a forgotten tab or a minimized app
 * does not keep a Mac running. A client that provides no signals counts the user as always here.
 */
export class UserPresence extends Context.Reference<{
  /** The current answer first, then each change. */
  readonly present: Stream.Stream<boolean>;
}>("@t3tools/client-runtime/connection/presence/UserPresence", {
  defaultValue: () => ({ present: Stream.concat(Stream.make(true), Stream.never) }),
}) {}

/** What a surface reports for presence: whether it is on screen, and each user input. */
export interface PresenceSignals {
  /** The current visibility first, then each change. */
  readonly visible: Stream.Stream<boolean>;
  readonly inputs: Stream.Stream<unknown>;
}

/** Derives presence from a surface's signals. Coming back on screen counts as input. */
export const makeUserPresence = Effect.fn("UserPresence.make")(function* (
  signals: PresenceSignals,
  awayAfter: Duration.Input = USER_AWAY_AFTER,
) {
  const awayAfterMs = Duration.toMillis(Duration.fromInputUnsafe(awayAfter));
  const present = yield* SubscriptionRef.make(false);
  const state = yield* Ref.make({ visible: false, lastInputAt: Number.NEGATIVE_INFINITY });
  const refresh = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { visible, lastInputAt } = yield* Ref.get(state);
    yield* SubscriptionRef.set(present, visible && now - lastInputAt < awayAfterMs);
  });
  const noteInput = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => Ref.update(state, (current) => ({ ...current, lastInputAt: now }))),
  );
  yield* signals.visible.pipe(
    Stream.runForEach((visible) =>
      Ref.update(state, (current) => ({ ...current, visible })).pipe(
        Effect.andThen(visible ? noteInput : Effect.void),
        Effect.andThen(refresh),
      ),
    ),
    Effect.forkScoped,
  );
  yield* signals.inputs.pipe(
    Stream.runForEach(() => noteInput.pipe(Effect.andThen(refresh))),
    Effect.forkScoped,
  );
  // Notices the hour running out with no input to report it.
  yield* Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const { lastInputAt } = yield* Ref.get(state);
      const left = lastInputAt + awayAfterMs - now;
      yield* Effect.sleep(left > 0 ? left : awayAfterMs);
      yield* refresh;
    }
  }).pipe(Effect.forkScoped);
  return UserPresence.of({ present: SubscriptionRef.changes(present).pipe(Stream.changes) });
});

export const layer = (signals: PresenceSignals) =>
  Layer.effect(UserPresence, makeUserPresence(signals));
