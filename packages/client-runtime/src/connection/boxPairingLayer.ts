import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ClientCapabilities from "../platform/capabilities.ts";
import { PairingRedemption } from "./boxPairing.ts";
import { preparePairingRegistration } from "./onboarding.ts";

/** Redeems a box's pairing the way `registerPairing` does, leaving the registry to save it. */
export const pairingRedemptionLayer = Layer.effect(
  PairingRedemption,
  Effect.gen(function* () {
    const presentation = yield* ClientCapabilities.ClientPresentation;
    const httpClient = yield* HttpClient.HttpClient;
    return PairingRedemption.of({
      redeem: (input) =>
        preparePairingRegistration(input).pipe(
          Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
