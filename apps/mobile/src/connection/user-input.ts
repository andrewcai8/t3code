import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const listeners = new Set<() => void>();

/** Reports a touch anywhere in the app; the app root calls this for every touch it sees. */
export function noteUserInput(): void {
  for (const listener of listeners) listener();
}

/** Each touch, at most once per `sampleMs`: presence only asks whether the user touched the app this hour. */
export const userInputs = (sampleMs: number): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let sampledAt = Number.NEGATIVE_INFINITY;
        const listener = () => {
          const now = Date.now();
          if (now - sampledAt < sampleMs) return;
          sampledAt = now;
          Queue.offerUnsafe(queue, undefined);
        };
        listeners.add(listener);
        return listener;
      }),
      (listener) => Effect.sync(() => listeners.delete(listener)),
    ).pipe(Effect.asVoid),
  );
