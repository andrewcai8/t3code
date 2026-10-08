import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { preparePairingRegistration } from "./onboarding.ts";

const CLIENT_PRESENTATION_LAYER = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: { label: "T3 Code Test", deviceType: "desktop", os: "Test OS" },
  }),
);

/** Serves only the environment descriptor, so any later pairing request fails the test. */
function descriptorOnlyHttpLayer(calls: Array<string>) {
  const fetchFn = ((input) => {
    const url = String(input);
    calls.push(url);
    if (!url.endsWith("/.well-known/t3/environment")) {
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }
    return Promise.resolve(
      Response.json({
        environmentId: "environment-paired",
        label: "Paired environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      }),
    );
  }) satisfies typeof fetch;
  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

describe("connection onboarding for cloud boxes", () => {
  it.effect("checks the discovered identity before consuming a pairing grant", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("expected-environment"),
      }).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, descriptorOnlyHttpLayer(calls))),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(calls).toEqual(["https://remote.example.test/.well-known/t3/environment"]);
    }),
  );
});
