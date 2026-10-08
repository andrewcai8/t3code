/**
 * The Cursor logins beyond the server's default one. Each Cursor instance can
 * hold its own login (a separate HOME or credential store). The usage scan
 * reads the default login itself, and reads each of these the same way.
 *
 * @module cursorLogins
 */
import type { ProviderInstanceConfig, ServerSettings } from "@t3tools/contracts";

import { cursorFileCredentialPath } from "../provider/cursorCredentialPath.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import type { CursorCredentialSource } from "./cursorAccountCache.ts";

export interface CursorLogin {
  readonly key: string;
  /** The saved login's path, which names the source when it cannot be read. */
  readonly dir: string;
  /** `null` when the environment authenticates without a saved login. */
  readonly credential: CursorCredentialSource | null;
  /** A Keychain login this server is not yet allowed to read. */
  readonly keychainOff: boolean;
}

function resolveCursorLogin(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  keychainUsageEnabled: boolean,
): CursorLogin {
  const dir = cursorFileCredentialPath(environment, platform, home);
  const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
  const loginUnavailable =
    Boolean(environment.CURSOR_AUTH_TOKEN?.trim()) ||
    Boolean(environment.CURSOR_API_KEY?.trim()) ||
    credentialStore === "memory";
  const keychain = platform === "darwin" && credentialStore !== "file";
  if (loginUnavailable) return { key: `none:${dir}`, dir, credential: null, keychainOff: false };
  if (keychain) {
    return {
      key: "keychain",
      dir,
      credential: { kind: "keychain" },
      keychainOff: !keychainUsageEnabled,
    };
  }
  return { key: dir, dir, credential: dir, keychainOff: false };
}

/** Every Cursor instance's login that differs from the default one, once each. */
export function otherCursorLogins(input: {
  readonly settings: Pick<ServerSettings, "providerInstances" | "cursorKeychainUsageEnabled">;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}): ReadonlyArray<CursorLogin> {
  const { settings, hostEnvironment, platform, home } = input;
  const login = (environment: ProviderInstanceConfig["environment"]) =>
    resolveCursorLogin(
      mergeProviderInstanceEnvironment(environment, hostEnvironment),
      platform,
      home,
      settings.cursorKeychainUsageEnabled,
    );
  const defaultKey = login(undefined).key;
  const logins = new Map<string, CursorLogin>();
  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver !== "cursor") continue;
    const resolved = login(instance.environment);
    if (resolved.key !== defaultKey && !resolved.keychainOff) logins.set(resolved.key, resolved);
  }
  return [...logins.values()];
}
