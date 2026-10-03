import { Presence } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

// Input this often is enough: presence only asks whether the user touched the app this hour.
const PRESENCE_INPUT_SAMPLE_MS = 30_000;
const PRESENCE_INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "scroll", "touchstart", "focus"];

/** Whether the user is here: the page is visible, and when they last touched it. */
export const presenceLayer = Presence.layer({
  visible: Stream.callback<boolean>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => Queue.offerUnsafe(queue, document.visibilityState === "visible");
        listener();
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
  inputs: Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let sampledAt = Number.NEGATIVE_INFINITY;
        const listener = () => {
          const now = performance.now();
          if (now - sampledAt < PRESENCE_INPUT_SAMPLE_MS) return;
          sampledAt = now;
          Queue.offerUnsafe(queue, undefined);
        };
        for (const event of PRESENCE_INPUT_EVENTS)
          window.addEventListener(event, listener, { capture: true, passive: true });
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          for (const event of PRESENCE_INPUT_EVENTS)
            window.removeEventListener(event, listener, { capture: true });
        }),
    ).pipe(Effect.asVoid),
  ),
});
