import { Presence } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AppState } from "react-native";

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

/** Presence for this phone: visible while the app is active, and each sampled touch. */
export const presenceLayer = Presence.layer({
  visible: Stream.callback<boolean>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        Queue.offerUnsafe(queue, AppState.currentState === "active");
        return AppState.addEventListener("change", (state) => {
          Queue.offerUnsafe(queue, state === "active");
        });
      }),
      (subscription) => Effect.sync(() => subscription.remove()),
    ).pipe(Effect.asVoid),
  ),
  inputs: userInputs(30_000),
});
