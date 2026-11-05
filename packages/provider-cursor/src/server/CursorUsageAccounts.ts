import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import { readStoredCursorApiKey } from "./credentialStore.ts";

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

export class CursorUsageAccounts extends Context.Service<
  CursorUsageAccounts,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<{
        readonly instanceId: ProviderInstanceId;
        readonly environment: NodeJS.ProcessEnv;
      }>;
      readonly keychainUsageEnabled: boolean;
      readonly windowStartMs: number;
      readonly retentionCutoffMs: number;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("@t3tools/provider-cursor/server/CursorUsageAccounts") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const accountReader = yield* CursorAccountReader.CursorAccountReader;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const digest = yield* Digest.Digest;

  const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  const caches = new Map<string, CursorAccountCache>();
  let cacheDirty = false;
  /** Failed refreshes share the cache TTL to prevent repeated requests; null means no login. */
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  const refreshes = new Map<string, Deferred.Deferred<void>>();

  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCacheFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
      }),
    ),
  );

  // Serialize snapshots; clear dirty before encoding and restore it on failure so changes retry.
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    yield* Effect.sync(() => encodeCursorAccountCaches(caches)).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("CursorUsageAccounts.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const refreshAccount = Effect.fn("CursorUsageAccounts.refreshAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fetchMissing = (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return accountReader
        .read(credential, range.sinceMs, range.untilMs)
        .pipe(Effect.map((result) => ({ range, result })));
    };
    let base = caches.get(credentialKey);
    let fetched = yield* fetchMissing(base);
    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      caches.delete(credentialKey);
      cacheDirty = true;
      base = undefined;
      fetched = yield* fetchMissing(base);
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      failures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
      });
      yield* schedulePersist;
      return;
    }
    const merged = mergeCursorFetch(
      base,
      result.accountKey,
      range,
      result.records,
      nowMs,
      retentionStartMs,
    );
    caches.set(credentialKey, merged.cache);
    failures.delete(credentialKey);
    if (merged.changed) cacheDirty = true;
    yield* schedulePersist;
  });

  const startRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    // Enroll and fork atomically so interruption cannot strand a registered refresh.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = refreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        refreshes.set(credentialKey, done);
        // Detached: a departing client must not cancel a fetch later reads reuse.
        yield* refreshAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) =>
                failures.set(credentialKey, { atMs, error: CURSOR_ACCOUNT_READ_ERROR }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              refreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  // Account history spans machines; a stable fingerprint prevents duplicate environment counts.
  const cachedSource = (cache: CursorAccountCache, windowStartMs: number) => {
    const source = `cursor-account:${cache.accountKey}`;
    return {
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
    } satisfies ProviderUsageScan;
  };

  const accountSource = Effect.fn("CursorUsageAccounts.accountSource")(function* (
    credential: CursorCredentialSource,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    // A Keychain login outlives an uninstalled Cursor, so it also needs Cursor's local directory.
    const localLogin =
      typeof credential === "string"
        ? credential
        : credential.kind === "keychain"
          ? path.dirname(authPath)
          : null;
    if (
      localLogin !== null &&
      !(yield* fileSystem.exists(localLogin).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return null;
    }
    yield* ensureLoaded;
    const credentialKey =
      typeof credential === "string"
        ? credential
        : credential.kind === "apiKey"
          ? // A fingerprint, so a replaced key never reads the previous account's cache.
            `api-key:${Hex.encode(
              yield* digest.digest(Digest.sha256, new TextEncoder().encode(credential.apiKey)),
            )}`
          : "keychain";
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = failures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs)
    ) {
      const refresh = yield* startRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) yield* Deferred.await(refresh);
      else refreshing = true;
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        dir: authPath,
        // Never combine a local fallback with another server's account-wide history.
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      } satisfies ProviderUsageScan;
    }
    return {
      ...cachedSource(cache, windowStartMs),
      ...(failureMessage === undefined
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ProviderUsageScan;
  });

  /** Where a Cursor CLI in this environment keeps its login. */
  const resolveLogin = (environment: NodeJS.ProcessEnv, home: string) => {
    const userHome =
      (platform === "win32" ? environment["USERPROFILE"] : environment["HOME"]) || home;
    const configHome = environment["XDG_CONFIG_HOME"]?.trim();
    const cursorHome =
      platform === "darwin"
        ? path.join(userHome, "Library", "Application Support")
        : platform === "win32"
          ? environment["APPDATA"] || path.join(userHome, "AppData", "Roaming")
          : configHome && path.isAbsolute(configHome)
            ? configHome
            : path.join(userHome, ".config");
    const authPath =
      platform === "darwin"
        ? path.join(userHome, ".cursor", "auth.json")
        : path.join(cursorHome, platform === "win32" ? "Cursor" : "cursor", "auth.json");
    const credentialStore = environment["AGENT_CLI_CREDENTIAL_STORE"];
    const loginUnavailable =
      Boolean(environment["CURSOR_AUTH_TOKEN"]?.trim()) || credentialStore === "memory";
    const useKeychain = platform === "darwin" && credentialStore !== "file";
    const key = loginUnavailable ? `none:${authPath}` : useKeychain ? "keychain" : authPath;
    return { authPath, loginUnavailable, useKeychain, key };
  };

  const scan: CursorUsageAccounts["Service"]["scan"] = Effect.fn("CursorUsageAccounts.scan")(
    function* ({
      instances,
      keychainUsageEnabled,
      windowStartMs,
      retentionCutoffMs,
      awaitRefresh,
    }) {
      const home = yield* HostProcess.HomeDirectory;
      const loginSource = (
        login: ReturnType<typeof resolveLogin>,
      ): Effect.Effect<ProviderUsageScan | null> =>
        login.loginUnavailable
          ? Effect.succeed({
              dir: login.authPath,
              files: null,
              message: "Cursor account history needs a Cursor CLI login on this server.",
            })
          : accountSource(
              login.useKeychain ? { kind: "keychain" } : login.authPath,
              login.authPath,
              windowStartMs,
              retentionCutoffMs,
              awaitRefresh,
            );

      const hostLogin = resolveLogin(hostEnvironment, home);
      // T3's Cursor sign-in and CURSOR_API_KEY name the account the agent uses, so they win.
      const apiKeys = yield* Effect.forEach(instances, ({ instanceId, environment }) =>
        environment.CURSOR_API_KEY?.trim()
          ? Effect.succeed(environment.CURSOR_API_KEY.trim())
          : readStoredCursorApiKey(instanceId).pipe(
              Effect.provideService(ProviderHost.ProviderHost, host),
              Effect.orElseSucceed(() => undefined),
            ),
      );
      const uniqueApiKeys = [...new Set(apiKeys.filter((apiKey) => apiKey !== undefined))];
      if (uniqueApiKeys.length > 0) {
        const keySources = yield* Effect.forEach(uniqueApiKeys, (apiKey) =>
          accountSource(
            { kind: "apiKey", apiKey },
            hostLogin.authPath,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          ),
        );
        // Keys for one account share its source, and a repeated source would count sessions twice.
        // A failed key can hold older records, so a current read wins, then a refresh the client
        // must follow up on.
        const rank = (source: ProviderUsageScan) =>
          source.status === "ok" ? 2 : source.refreshing ? 1 : 0;
        const byAccount = new Map<string, ProviderUsageScan>();
        for (const source of keySources) {
          if (source === null) continue;
          const kept = byAccount.get(source.dir);
          if (kept === undefined || rank(source) > rank(kept)) {
            byAccount.set(source.dir, source);
          }
        }
        // Stored history is left out here, so a replaced key never shows the previous account.
        return [...byAccount.values()];
      }
      // Instances with their own Cursor login, beyond the host's, once each.
      const instanceLogins = new Map<string, ReturnType<typeof resolveLogin>>();
      for (const { environment } of instances) {
        const login = resolveLogin(environment, home);
        if (login.key === hostLogin.key || (login.key === "keychain" && !keychainUsageEnabled))
          continue;
        instanceLogins.set(login.key, login);
      }
      const others = yield* Effect.forEach(instanceLogins.values(), loginSource, {
        concurrency: "unbounded",
      });
      const hostSources: ReadonlyArray<ProviderUsageScan | null> =
        hostLogin.useKeychain && !hostLogin.loginUnavailable && !keychainUsageEnabled
          ? [
              {
                dir: hostLogin.authPath,
                volumeId: "",
                files: null,
                message: "Cursor account usage is off on this environment.",
                action: "enableCursorKeychain",
              },
            ]
          : [yield* loginSource(hostLogin)];
      const sources = [...hostSources, ...others];
      // An account reached through several logins counts once, from the first login that reads it.
      const seen = new Set<string>();
      const live = sources.filter((source): source is ProviderUsageScan => {
        if (source === null || seen.has(source.dir)) return false;
        seen.add(source.dir);
        return true;
      });
      // A removed or signed-out login keeps its account's history on the page,
      // as stored; with no login left there is nothing to refresh it from.
      yield* ensureLoaded;
      const stored = [...caches.values()]
        .map((cache) => cachedSource(cache, windowStartMs))
        .filter((source) => {
          if (seen.has(source.dir)) return false;
          seen.add(source.dir);
          return true;
        })
        .map((source) => ({ ...source, status: "ok" as const }));
      return [...live, ...stored];
    },
  );

  return CursorUsageAccounts.of({ scan, awaitPersisted });
});

export const layer = Layer.effect(CursorUsageAccounts, make);
