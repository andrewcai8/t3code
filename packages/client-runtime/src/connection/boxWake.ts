import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type ConnectionAttemptError,
  type ConnectionBlockedError,
  ConnectionTransientError,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "./model.ts";

// A box that keeps saying it is not serving is woken again after 30 s, then 1, 2, 4 and 8
// minutes, and every 10 minutes after that, so no client resumes it in a loop.
const WAKE_INTERVAL_MS = 30_000;
const WAKE_INTERVAL_MAX_MS = 600_000;

export type BoxWakeOutcome =
  | { readonly _tag: "Resumed" }
  | { readonly _tag: "RetryLater"; readonly error: ConnectionTransientError }
  | { readonly _tag: "Refused"; readonly error: ConnectionBlockedError }
  /** The host never answered: it was not connected, or its session closed first. */
  | { readonly _tag: "Undelivered"; readonly error: ConnectionTransientError };

/** What a supervisor of a cloud box is given on top of an ordinary one. */
export interface BoxSupervisorOptions {
  /** Wakes a box whose dial says it is not serving, through the host that provisioned it. */
  readonly wake?: Effect.Effect<BoxWakeOutcome>;
  /** Runs while the connection is up, as a box's lease heartbeat does. */
  readonly keepAlive?: Effect.Effect<void>;
  /** Whether a wake may start now: its user is here and its host is connected to hear it. */
  readonly mayWake?: Effect.Effect<boolean>;
}

function wakeIntervalMs(wakes: number): number {
  return Math.min(WAKE_INTERVAL_MS * 2 ** (wakes - 1), WAKE_INTERVAL_MAX_MS);
}

/**
 * One supervisor loop's wakes of its box. `reset` runs whenever the loop forgets its failures:
 * the box stayed connected, or its chat closed and opening it again is a fresh ask that does not
 * wait out an old interval.
 */
export function makeBoxWaker(
  options: BoxSupervisorOptions | undefined,
  supervisor: {
    readonly intent: Effect.Effect<{ readonly desired: boolean; readonly network: NetworkStatus }>;
    readonly setState: (state: SupervisorConnectionState) => Effect.Effect<void>;
    readonly nextSignal: Effect.Effect<{ readonly _tag: string; readonly network?: NetworkStatus }>;
  },
) {
  // Wakes since the box last stayed connected, and when the next one may start.
  let wakes = 0;
  let nextWakeAt = 0;

  const interrupted = Effect.gen(function* () {
    for (;;) {
      const next = yield* supervisor.nextSignal;
      if (
        next._tag === "DisconnectRequested" ||
        next._tag === "RetryRequested" ||
        (next._tag === "NetworkChanged" && next.network === "offline")
      ) {
        return { _tag: "Interrupted" } as const;
      }
    }
  });

  const wakeBox = Effect.fnUntraced(function* (
    wake: Effect.Effect<BoxWakeOutcome>,
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError,
  ) {
    const current = yield* supervisor.intent;
    if (!current.desired || current.network === "offline") {
      return { _tag: "Interrupted" } as const;
    }
    yield* supervisor.setState({
      desired: true,
      network: current.network,
      phase: "waking",
      stage: null,
      attempt,
      generation,
      lastFailure,
      retryAt: null,
    });
    // However a wake ends, the loop goes on: a wake that fails instead of answering is treated as
    // one the host never heard, so the box cannot be left waking with nothing running.
    const settledWake = wake.pipe(
      Effect.catchCause(() =>
        Effect.succeed<BoxWakeOutcome>({
          _tag: "Undelivered",
          error: new ConnectionTransientError({
            reason: "not-serving",
            detail: "This chat's cloud host did not answer the wake.",
          }),
        }),
      ),
    );
    return yield* Effect.raceFirst(settledWake, interrupted);
  });

  /**
   * Wakes the box when a dial failed with `error` because it is not serving and a wake is due.
   * None means dial again now; otherwise the failure the loop goes on with.
   */
  const afterFailure = Effect.fnUntraced(function* (
    error: ConnectionAttemptError,
    attempt: number,
    generation: number,
  ) {
    if (
      options?.wake === undefined ||
      error.reason !== "not-serving" ||
      (yield* Clock.currentTimeMillis) < nextWakeAt ||
      !(yield* options.mayWake ?? Effect.succeed(true))
    ) {
      return Option.some(error);
    }
    const woken: BoxWakeOutcome | { readonly _tag: "Interrupted" } = yield* wakeBox(
      options.wake,
      attempt,
      generation,
      error,
    );
    if (woken._tag === "Interrupted") return Option.none();
    // Only a wake the host answered counts toward the interval; one it never heard is not a
    // wake, and is sent again on the next dial.
    if (woken._tag !== "Undelivered") {
      wakes += 1;
      nextWakeAt = (yield* Clock.currentTimeMillis) + wakeIntervalMs(wakes);
    }
    if (woken._tag === "Resumed") return Option.none();
    return Option.some(woken.error);
  });

  return {
    reset: () => {
      wakes = 0;
      nextWakeAt = 0;
    },
    afterFailure,
  };
}
