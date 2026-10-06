import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { credentialSecretName } from "./providerCredentialName.ts";

it.effect("names the secret upstream's credential store writes a binding under", () =>
  Effect.gen(function* () {
    const written = new Map<string, Uint8Array>();
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(written.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          written.set(name, value);
        }),
      remove: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    });
    const store = yield* ProviderCredentialStore.make("cursor", "cursor_work").pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
    );
    yield* store.set(Uint8Array.from([1, 2, 3]));

    const secret = "provider-auth-1708c8c8cb8bae5421c955c9031310df41eddd9f868172bd383a19ef2fdada72";
    assert.deepStrictEqual([...written.keys()], [secret]);
    assert.strictEqual(credentialSecretName("cursor", "cursor_work"), secret);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
