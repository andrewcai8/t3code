/**
 * Uploads this machine's usage history to a T3 host, so the host's Usage page counts a machine
 * no client connects to. It runs the server's own usage scanner over the provider homes in this
 * machine's T3 settings, then replaces what the host keeps for this machine.
 *
 *   node apps/server/scripts/import-machine-usage.ts --dry-run
 *   node apps/server/scripts/import-machine-usage.ts --origin https://host \
 *     --pairing-token-file ~/.t3/audit/secrets/host-pairing-token
 *
 * The machine's T3 home is only read. The scanner keeps its rate table and parse cache under
 * `--cache-dir`, which also keeps usage from transcripts a CLI has since cleaned up, as a local
 * server would. The bearer is cached beside the pairing token (0600) until it expires. Tokens
 * never reach stdout.
 */
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ServerSettings,
  UsageImportInput,
  UsageImportResult,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../src/config.ts";
import * as ServerSettingsService from "../src/serverSettings.ts";
import { BoxUsageStore } from "../src/usage/boxUsage.ts";
import * as UsageService from "../src/usage/UsageService.ts";

class ImportFailure extends Schema.TaggedError<ImportFailure>()("ImportFailure", {
  message: Schema.String,
}) {}

const decodeSettings = Schema.decodeUnknownEffect(fromLenientJson(ServerSettings));
const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);
const decodeImportResult = Schema.decodeUnknownEffect(UsageImportResult);
const encodeImport = Schema.encodeEffect(Schema.fromJsonString(UsageImportInput));
const encodeReport = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));
const BearerCache = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.String, accessToken: Schema.String, expiresAt: Schema.Finite }),
);
const decodeBearerCache = Schema.decodeUnknownEffect(BearerCache);
const encodeBearerCache = Schema.encodeEffect(BearerCache);

/**
 * Variables that would move a scanned home or its identity away from what the machine's own
 * server reports. An agent's shell sets `CLAUDE_CONFIG_DIR`, for one, which would redirect the
 * default Claude home to that agent's account.
 */
const SERVER_ONLY_VARIABLES = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
  "T3CODE_USAGE_HOST_ID",
]);

/**
 * This machine's hourly UTC usage since `sinceTime`, from the server's scanner. Cursor is left
 * out: the host reads the Cursor account itself, and the scan must not touch the keychain.
 */
const scanHistory = (input: {
  readonly t3Home: string;
  readonly cacheDir: string;
  readonly sinceTime: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsPath = path.join(input.t3Home, "userdata", "settings.json");
    const raw = (yield* fs.exists(settingsPath)) ? yield* fs.readFileString(settingsPath) : "{}";
    const settings = yield* decodeSettings(raw);
    const providerInstances = Object.fromEntries(
      Object.entries(settings.providerInstances).filter(
        ([, instance]) => instance.driver !== "cursor",
      ),
    );
    const environment = yield* HostProcessEnvironment;
    const usage = yield* UsageService.make.pipe(
      Effect.provideService(
        HostProcessEnvironment,
        Object.fromEntries(
          Object.entries(environment).filter(([key]) => !SERVER_ONLY_VARIABLES.has(key)),
        ),
      ),
      Effect.provide(
        Layer.mergeAll(
          // The scanner reads only its cache directory from the config and its homes from
          // settings, so the in-memory layers stand in for a server without starting one.
          ServerConfig.layerTest(input.cacheDir, input.cacheDir),
          ServerSettingsService.layerTest({
            ...settings,
            providerInstances,
            cursorKeychainUsageEnabled: false,
          }),
          Layer.succeed(
            BoxUsageStore,
            BoxUsageStore.of({
              replace: () => Effect.void,
              list: () => Effect.succeed([]),
              prune: () => Effect.void,
            }),
          ),
        ),
      ),
    );
    return yield* usage.readHistory({ sinceTime: input.sinceTime });
  });

const tokens = (bucket: UsageSummary["buckets"][number]) =>
  bucket.totals.uncachedInputTokens +
  bucket.totals.cachedInputTokens +
  bucket.totals.cacheCreationTokens +
  bucket.totals.outputTokens;

/** Per-provider totals, the figures a dry run shows before anything is uploaded. */
const describeHistory = (history: UsageSummary) => {
  const providers = new Map<
    UsageProviderKind,
    { tokens: number; costUsd: number; firstHour: string; lastHour: string; buckets: number }
  >();
  for (const bucket of history.buckets) {
    const hour = bucket.hourStart ?? bucket.day;
    const totals = providers.get(bucket.provider) ?? {
      tokens: 0,
      costUsd: 0,
      firstHour: hour,
      lastHour: hour,
      buckets: 0,
    };
    totals.tokens += tokens(bucket);
    totals.costUsd += bucket.costUsd;
    totals.buckets += 1;
    if (hour < totals.firstHour) totals.firstHour = hour;
    if (hour > totals.lastHour) totals.lastHour = hour;
    providers.set(bucket.provider, totals);
  }
  return [...providers].map(([provider, totals]) => ({
    provider,
    tokens: totals.tokens,
    costUsd: Math.round(totals.costUsd * 100) / 100,
    firstHour: totals.firstHour,
    lastHour: totals.lastHour,
    buckets: totals.buckets,
    sessions: history.sources
      .filter((source) => source.fingerprint.provider === provider)
      .reduce((sum, source) => sum + source.distinctSessions, 0),
    sources: history.sources
      .filter((source) => source.fingerprint.provider === provider)
      .map((source) => source.fingerprint.resolvedHomePath),
  }));
};

/** A decode failure's message quotes the answer, which may hold a token. */
const describe = (cause: { readonly _tag: string; readonly message: string }) =>
  cause._tag === "SchemaError" ? "the host's answer did not decode" : cause.message;

const bearerFor = (origin: string, pairingTokenFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cachePath = `${pairingTokenFile}.bearer.json`;
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.flatMap(decodeBearerCache), Effect.option);
    if (
      Option.isSome(cached) &&
      cached.value.origin === origin &&
      cached.value.expiresAt - now > 15 * 60_000
    ) {
      return cached.value.accessToken;
    }
    const credential = (yield* fs.readFileString(pairingTokenFile)).trim();
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const token = yield* http
      .execute(
        HttpClientRequest.post(new URL("oauth/token", origin)).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            client_label: "usage import",
            client_device_type: "bot",
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeAccessToken),
        Effect.timeout("1 minute"),
        Effect.mapError(
          (cause) => new ImportFailure({ message: `token exchange failed: ${describe(cause)}` }),
        ),
      );
    yield* fs.writeFileString(
      cachePath,
      yield* encodeBearerCache({
        origin,
        accessToken: token.access_token,
        expiresAt: now + token.expires_in * 1000,
      }),
      { mode: 0o600 },
    );
    yield* fs.chmod(cachePath, 0o600);
    return token.access_token;
  });

const command = Command.make(
  "import-machine-usage",
  {
    origin: Flag.String("origin").pipe(
      Flag.withDescription("Host origin, e.g. https://host"),
      Flag.optional,
    ),
    pairingTokenFile: Flag.String("pairing-token-file").pipe(
      Flag.withDescription("File holding a host pairing token; the bearer is cached beside it."),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Scan and print per-provider totals without uploading."),
      Flag.withDefault(false),
    ),
    remove: Flag.Boolean("remove").pipe(
      Flag.withDescription("Delete what the host keeps for this machine instead of replacing it."),
      Flag.withDefault(false),
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription(
        "First UTC day or instant to include. Defaults to all history the host keeps (90 days).",
      ),
      Flag.optional,
    ),
    t3Home: Flag.String("t3-home").pipe(
      Flag.withDescription("This machine's T3 home, read for settings and its environment id."),
      Flag.withDefault(`${NodeOS.homedir()}/.t3`),
    ),
    cacheDir: Flag.String("cache-dir").pipe(
      Flag.withDescription("Where the scanner keeps its caches."),
      Flag.withDefault(`${NodeOS.homedir()}/.t3/usage-import-cache`),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const t3Home = path.resolve(flags.t3Home);
      const cacheDir = path.resolve(flags.cacheDir);
      // The scanner writes under `<cache-dir>/userdata`, which must never be the live state.
      const fromUserdata = path.relative(path.join(t3Home, "userdata"), cacheDir);
      if (
        cacheDir === t3Home ||
        !(fromUserdata.startsWith("..") || path.isAbsolute(fromUserdata))
      ) {
        return yield* new ImportFailure({
          message: "--cache-dir must be outside the machine's T3 userdata",
        });
      }
      const target = Option.all({ origin: flags.origin, pairingTokenFile: flags.pairingTokenFile });
      if (!flags.dryRun && Option.isNone(target)) {
        return yield* new ImportFailure({
          message: "--origin and --pairing-token-file are required unless --dry-run",
        });
      }
      const now = yield* DateTime.now;
      // The scanner bounds the window by what the host keeps.
      const sinceTime = Option.getOrElse(flags.since, () => "1970-01-01T00:00:00.000Z");
      const machineId = (yield* fs
        .readFileString(path.join(t3Home, "userdata", "environment-id"))
        .pipe(
          Effect.mapError(
            () =>
              new ImportFailure({
                message: `no environment id under ${t3Home}; the host keys this machine's usage by it`,
              }),
          ),
        )).trim();

      const scanned = yield* scanHistory({ t3Home, cacheDir, sinceTime });
      const history = flags.remove ? { ...scanned, sources: [], buckets: [] } : scanned;
      const body = yield* encodeImport({ machineId, history });
      yield* Console.log(
        yield* encodeReport({
          machineId,
          hostId: history.sources[0]?.fingerprint.hostId ?? null,
          scannedAt: DateTime.formatIso(now),
          scanDurationMs: history.scanDurationMs,
          payloadBytes: Buffer.byteLength(body),
          providers: describeHistory(history),
        }),
      );
      if (flags.dryRun || Option.isNone(target)) return;

      const origin = new URL(target.value.origin).origin;
      const bearer = yield* bearerFor(origin, path.resolve(target.value.pairingTokenFile));
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const imported = yield* http
        .execute(
          HttpClientRequest.post(new URL("api/usage/import", origin)).pipe(
            HttpClientRequest.bearerToken(bearer),
            HttpClientRequest.bodyText(body, "application/json"),
          ),
        )
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeImportResult),
          Effect.timeout("5 minutes"),
          Effect.mapError(
            (cause) => new ImportFailure({ message: `import failed: ${describe(cause)}` }),
          ),
        );
      yield* Console.log(yield* encodeReport({ imported }));
    }),
).pipe(Command.withDescription("Upload this machine's usage history to a T3 host."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
