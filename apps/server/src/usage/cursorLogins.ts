/**
 * Cursor account history for the Cursor logins beyond the server's default
 * one. Each Cursor instance can hold its own login (a separate HOME or
 * credential store); the usage scan reads the default login itself, and this
 * module reads every other login, counting each account once.
 *
 * @module cursorLogins
 */
import type { ProviderInstanceConfig, ServerSettings, UsageSource } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { cursorFileCredentialPath } from "../provider/cursorCredentialPath.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import type { CursorCredentialSource, makeCursorAccountHistory } from "./cursorAccountHistory.ts";
import { readDirectoryVolumeId } from "./usageTranscriptReader.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

/** One Cursor entry of the usage scan, in the shape UsageService scans directories into. */
export interface CursorLoginSource {
  readonly provider: "cursor";
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly files:
    | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
    | null;
}

interface CursorLogin {
  readonly key: string;
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

/**
 * Sources for every Cursor instance whose login differs from the default one
 * the scan reads from the host environment. `readHistory` is the scan's own
 * history reader, so settled rows are shared with it.
 */
export const readOtherCursorLogins = Effect.fn("readOtherCursorLogins")(function* (input: {
  readonly settings: Pick<ServerSettings, "providerInstances" | "cursorKeychainUsageEnabled">;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly sinceMs: number;
  readonly readHistory: ReturnType<typeof makeCursorAccountHistory>;
}) {
  const { settings, hostEnvironment, platform, home } = input;
  const login = (environment: ProviderInstanceConfig["environment"]) =>
    resolveCursorLogin(
      mergeProviderInstanceEnvironment(environment, hostEnvironment),
      platform,
      home,
      settings.cursorKeychainUsageEnabled,
    );
  const defaultLogin = login(undefined);
  const logins = new Map<string, CursorLogin>();
  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver !== "cursor") continue;
    const resolved = login(instance.environment);
    if (resolved.key !== defaultLogin.key && !resolved.keychainOff) {
      logins.set(resolved.key, resolved);
    }
  }
  if (logins.size === 0) return [];

  const untilMs = yield* Clock.currentTimeMillis;
  return yield* Effect.promise(async () => {
    // The scan reads the default login right after this, served from the
    // shared history, so its account is known here and not reported twice.
    const defaultAccount =
      defaultLogin.credential !== null && !defaultLogin.keychainOff
        ? await input.readHistory(defaultLogin.credential, input.sinceMs, untilMs)
        : undefined;
    const accounts = await Promise.all(
      [...logins.values()].map(async ({ dir, credential }) => ({
        dir,
        account:
          credential === null
            ? {
                accountKey: null,
                records: [],
                missing: true,
                error: "Cursor account history needs a Cursor CLI login on this server.",
              }
            : await input.readHistory(credential, input.sinceMs, untilMs),
      })),
    );
    const sources: CursorLoginSource[] = [];
    const readAccounts = new Set<string>();
    if (defaultAccount?.accountKey && defaultAccount.error === null && !defaultAccount.missing) {
      readAccounts.add(defaultAccount.accountKey);
    }
    for (const { account } of accounts) {
      if (account.accountKey === null || account.error !== null || account.missing) continue;
      if (readAccounts.has(account.accountKey)) continue;
      readAccounts.add(account.accountKey);
      const source = `cursor-account:${account.accountKey}`;
      sources.push({
        provider: "cursor",
        dir: source,
        hostId: "cursor.com",
        volumeId: account.accountKey,
        files: [{ path: source, records: account.records }],
        status: "ok",
      });
    }
    for (const { dir, account } of accounts) {
      // No saved login means there is no account source to report, not a setup error.
      if (account.missing && account.error === null) continue;
      if (account.accountKey !== null && readAccounts.has(account.accountKey)) continue;
      sources.push({
        provider: "cursor",
        dir,
        volumeId: await readDirectoryVolumeId(dir),
        // Never combine a local fallback with another server's account-wide history.
        files: null,
        message:
          account.error ?? "Cursor account history needs a Cursor CLI login saved on this server.",
      });
    }
    return sources;
  });
});
