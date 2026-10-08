import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";

import * as ClientCapabilities from "../platform/capabilities.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import { PairingRedemption } from "./boxPairing.ts";
import { preparePairingRegistration } from "./onboarding.ts";

/**
 * Redeems a box's pairing the way `registerPairing` does, leaving the registry to save it, and
 * reads the grant a box's bearer pairing holds.
 */
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
      sessionGrant: (prepared) =>
        fetchEnvironmentSessionState({ prepared, signer: Option.none() }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.option,
        ),
    });
  }),
);
