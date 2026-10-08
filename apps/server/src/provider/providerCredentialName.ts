// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous name; Effect's Crypto is effectful.
import * as NodeCrypto from "node:crypto";

/** The secret a binding's credentials live under; hashed so no binding escapes a filename. */
export const credentialSecretName = (driver: string, bindingId: string) =>
  `provider-auth-${NodeCrypto.createHash("sha256")
    .update(`${driver.length}:${driver}${bindingId}`)
    .digest("hex")}`;
