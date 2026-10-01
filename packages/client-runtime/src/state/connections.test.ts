import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { awaitConnection } from "./connections.ts";

const state = (
  phase: SupervisorConnectionState["phase"],
  lastFailure: SupervisorConnectionState["lastFailure"] = null,
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: phase !== "available",
  phase,
  lastFailure,
});
const NOT_SERVING = new ConnectionTransientError({ reason: "not-serving", detail: "404" });
const DENIED = new ConnectionBlockedError({ reason: "authentication", detail: "Sign in again." });

const outcome = (states: ReadonlyArray<SupervisorConnectionState>) =>
  awaitConnection(Stream.fromIterable(states)).pipe(
    Effect.match({ onFailure: (error) => `failed: ${error.message}`, onSuccess: () => "ready" }),
  );

describe("waiting for a queued send's connection", () => {
  it.effect("waits through a box's wake until it connects", () =>
    Effect.gen(function* () {
      expect(
        yield* outcome([
          state("backoff", NOT_SERVING),
          state("waking", NOT_SERVING),
          state("connecting"),
          state("connected"),
        ]),
      ).toBe("ready");
    }),
  );

  it.effect("ends when the connection is switched off", () =>
    Effect.gen(function* () {
      expect(yield* outcome([state("backoff", NOT_SERVING), state("available")])).toBe(
        "failed: The environment was disconnected. The message is still in the composer.",
      );
    }),
  );

  it.effect("fails on a block that comes after the retry, not one from before it", () =>
    Effect.gen(function* () {
      expect(
        yield* outcome([state("blocked", DENIED), state("connecting"), state("connected")]),
      ).toBe("ready");
      expect(yield* outcome([state("connecting"), state("blocked", DENIED)])).toBe(
        "failed: Sign in again.",
      );
    }),
  );
});
