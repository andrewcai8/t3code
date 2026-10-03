import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

/** Pairs a cloud box this phone started, saving it as its host's box rather than a user machine. */
export const connectBoxPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-box-pairing",
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly pairingUrl: string }) => input.pairingUrl,
  },
  execute: (input: { readonly pairingUrl: string; readonly managerId: EnvironmentId }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) =>
        onboarding.registerPairing({
          pairingUrl: input.pairingUrl,
          box: { managerId: input.managerId },
        }),
      ),
    ),
});
