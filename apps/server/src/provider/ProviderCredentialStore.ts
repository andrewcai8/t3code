import * as Effect from "effect/Effect";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { credentialSecretName } from "./providerCredentialName.ts";

export { credentialSecretName };

/** A provider binding stores opaque bytes; only its adapter decodes or refreshes them. */
export const make = Effect.fn("ProviderCredentialStore.make")(function* (
  driver: string,
  bindingId: string,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const key = credentialSecretName(driver, bindingId);
  return {
    binding: { owner: "t3" as const, key },
    get: secrets.get(key),
    set: (credentials: Uint8Array) => secrets.set(key, credentials),
    remove: secrets.remove(key),
  };
});
