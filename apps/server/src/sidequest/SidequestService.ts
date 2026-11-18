import {
  SidequestAd,
  type SidequestConnection,
  type SidequestFetchAdInput,
  type SidequestReportImpressionInput,
  type RunId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const DEFAULT_BASE_URL = "https://getsidequest.dev";
const LOCAL_BASE_URL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/u;
const DEVICE_SECRET = "sidequest-device";
const REQUEST_TIMEOUT = "10 seconds";
const MAX_TEXT_LENGTH = 4000;
const MAX_CACHED_RUNS = 200;
const IMPRESSION_RETRIES = 3;

const DeviceState = Schema.Struct({
  deviceKey: Schema.String,
  pending: Schema.NullOr(Schema.Struct({ userCode: Schema.String, expiresAt: Schema.String })),
});
type DeviceState = typeof DeviceState.Type;
// The marker keeps a disconnected host from adopting the Claude Code plugin's key again.
const DISCONNECTED = { disconnected: true } as const;
const StoredState = Schema.Union([
  DeviceState,
  Schema.Struct({ disconnected: Schema.Literal(true) }),
]);
type StoredState = typeof StoredState.Type;
const StoredStateJson = Schema.fromJsonString(StoredState);
const decodeStoredState = Schema.decodeUnknownOption(StoredStateJson);
const encodeStoredState = Schema.encodeSync(StoredStateJson);

const PluginDevice = Schema.fromJsonString(
  Schema.Struct({ deviceKey: Schema.String.check(Schema.isNonEmpty()) }),
);
const decodePluginDevice = Schema.decodeUnknownOption(PluginDevice);
const PLUGIN_FILE = /^sidequest_sidequest-.*\.json$/u;

const DeviceCreated = Schema.Struct({ userCode: Schema.String, expiresAt: Schema.String });
const DeviceStatus = Schema.Struct({ email: Schema.String });
const decodeDeviceCreated = Schema.decodeUnknownOption(DeviceCreated);
const decodeDeviceStatus = Schema.decodeUnknownOption(DeviceStatus);
const decodeAd = Schema.decodeUnknownOption(SidequestAd);

// No cause: a failed request carries the device key in its headers.
class SidequestRequestError extends Schema.TaggedError<SidequestRequestError>()(
  "SidequestRequestError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Sidequest request failed: ${this.operation}.`;
  }
}

interface LoadedDevice extends DeviceState {
  readonly adopted: boolean;
}

interface SidequestResponse {
  readonly status: number;
  readonly body: unknown;
}

interface CachedAd {
  readonly ad: SidequestAd | null;
  readonly reported: boolean;
}

const disconnected = { status: "disconnected" } as const satisfies SidequestConnection;
const unavailable = { status: "unavailable" } as const satisfies SidequestConnection;

const osName = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";

const clip = (text: string, limit: number, from: "start" | "end") =>
  text.length <= limit ? text : from === "start" ? text.slice(0, limit) : text.slice(-limit);

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/** A host's own Sidequest device: connects it, and shows one sponsored line per person-typed turn. */
export class SidequestService extends Context.Service<
  SidequestService,
  {
    readonly getConnection: Effect.Effect<SidequestConnection>;
    readonly connect: Effect.Effect<SidequestConnection>;
    readonly disconnect: Effect.Effect<SidequestConnection>;
    readonly fetchAd: (input: SidequestFetchAdInput) => Effect.Effect<SidequestAd | null>;
    readonly reportImpression: (input: SidequestReportImpressionInput) => Effect.Effect<void>;
  }
>()("t3/sidequest/SidequestService") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const platform = yield* HostProcess.Platform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const override = yield* Config.String("T3CODE_SIDEQUEST_URL").pipe(Config.option, Effect.orDie);
  const baseUrl = override.pipe(
    Option.filter((value) => LOCAL_BASE_URL.test(value)),
    Option.map((value) => value.replace(/\/$/u, "")),
    Option.getOrElse(() => DEFAULT_BASE_URL),
  );

  const deviceLock = yield* Semaphore.make(1);
  const adLock = yield* Semaphore.make(1);
  const cache = yield* Ref.make<ReadonlyMap<RunId, CachedAd>>(new Map());

  const readStored = secrets
    .get(DEVICE_SECRET)
    .pipe(
      Effect.map((bytes) =>
        bytes.pipe(Option.flatMap((value) => decodeStoredState(new TextDecoder().decode(value)))),
      ),
    );
  const writeStored = (state: StoredState) =>
    secrets.set(DEVICE_SECRET, new TextEncoder().encode(encodeStoredState(state)));

  const readPluginKey = Effect.gen(function* () {
    const store = path.join(yield* HostProcess.HomeDirectory, ".claude", "plugins", "store");
    const [name] = (yield* fileSystem.readDirectory(store))
      .filter((entry) => PLUGIN_FILE.test(entry))
      .toSorted();
    if (name === undefined) return Option.none<string>();
    const text = yield* fileSystem.readFileString(path.join(store, name));
    return decodePluginDevice(text).pipe(Option.map((device) => device.deviceKey));
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

  /** The stored device, else the Claude Code plugin's key on a host that never connected or disconnected. */
  const loadDevice = Effect.gen(function* () {
    const stored = yield* readStored;
    if (Option.isSome(stored)) {
      return "deviceKey" in stored.value
        ? Option.some<LoadedDevice>({ ...stored.value, adopted: false })
        : Option.none<LoadedDevice>();
    }
    const adopted = yield* readPluginKey;
    return Option.map(adopted, (deviceKey) => ({ deviceKey, pending: null, adopted: true }));
  });

  const send = Effect.fn("SidequestService.send")(function* (
    operation: string,
    method: "GET" | "POST",
    path: string,
    deviceKey: string,
    body?: unknown,
  ) {
    const request = HttpClientRequest.make(method)(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bearerToken(deviceKey),
      (current) => (body === undefined ? current : HttpClientRequest.bodyJsonUnsafe(current, body)),
    );
    // Close after reading status and body so open bodies cannot hang; tracing off keeps the URL out of spans.
    return yield* httpClient.execute(request).pipe(
      Effect.flatMap((response): Effect.Effect<SidequestResponse, unknown> =>
        response.status === 200 || response.status === 201
          ? Effect.map(response.json, (json) => ({ status: response.status, body: json }))
          : Effect.succeed({ status: response.status, body: undefined }),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(() => new SidequestRequestError({ operation })),
      Effect.withTracerEnabled(false),
    );
  });

  const getConnection = Effect.fn("SidequestService.getConnection")(function* () {
    const loaded = yield* loadDevice.pipe(Effect.option);
    if (Option.isNone(loaded)) return unavailable;
    if (Option.isNone(loaded.value)) return disconnected;
    const state = loaded.value.value;
    const response = yield* send("status", "GET", "/api/device", state.deviceKey).pipe(
      Effect.option,
    );
    if (Option.isNone(response)) return unavailable;
    const { status, body } = response.value;
    if (status === 200) {
      const device = decodeDeviceStatus(body);
      if (Option.isNone(device)) return unavailable;
      if (state.pending !== null || state.adopted) {
        yield* writeStored({ deviceKey: state.deviceKey, pending: null }).pipe(
          Effect.ignoreCause({ log: true }),
        );
      }
      return { status: "connected", email: device.value.email } as const;
    }
    if (status === 403) return { status: "suspended" } as const;
    if (status === 202 && state.pending !== null) {
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = DateTime.make(state.pending.expiresAt).pipe(
        Option.map(DateTime.toEpochMillis),
      );
      if (Option.isSome(expiresAt) && expiresAt.value > now) {
        return {
          status: "pending",
          connectUrl: `${baseUrl}/connect?code=${encodeURIComponent(state.pending.userCode)}`,
          userCode: state.pending.userCode,
          expiresAt: state.pending.expiresAt,
        } as const;
      }
    }
    if (status === 202 || status === 404) {
      yield* writeStored(DISCONNECTED).pipe(Effect.ignoreCause({ log: true }));
      return disconnected;
    }
    return unavailable;
  });

  const connect = Effect.fn("SidequestService.connect")(function* () {
    const bytes = yield* random.randomBytes(32);
    const deviceKey = `sq_${base64UrlEncode(bytes)}`;
    const response = yield* send("connect", "POST", "/api/device", deviceKey, {
      os: osName(platform),
      client: "t3code",
    }).pipe(Effect.option);
    if (Option.isNone(response) || response.value.status !== 201) return unavailable;
    const created = decodeDeviceCreated(response.value.body);
    if (Option.isNone(created)) return unavailable;
    yield* writeStored({ deviceKey, pending: created.value });
    return {
      status: "pending",
      connectUrl: `${baseUrl}/connect?code=${encodeURIComponent(created.value.userCode)}`,
      userCode: created.value.userCode,
      expiresAt: created.value.expiresAt,
    } as const;
  });

  const disconnect = Effect.fn("SidequestService.disconnect")(function* () {
    yield* writeStored(DISCONNECTED);
    return disconnected;
  });

  const requestAd = Effect.fn("SidequestService.requestAd")(function* (
    deviceKey: string,
    { threadId, runId }: SidequestFetchAdInput,
  ) {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined || run.status !== "completed") return Option.none<SidequestAd | null>();
    const { messages: userMessages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const user = userMessages[0];
    if (
      user === undefined ||
      user.createdBy !== "user" ||
      (user.creationSource !== "web" && user.creationSource !== "mobile")
    ) {
      return Option.none<SidequestAd | null>();
    }
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [runId],
      messageRoles: ["assistant"],
    });
    const answer = clip(
      messages
        .toSorted(
          (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
        )
        .map((message) => message.text.trim())
        .filter((text) => text.length > 0)
        .join("\n\n"),
      MAX_TEXT_LENGTH,
      "end",
    );
    const question = clip(user.text, MAX_TEXT_LENGTH, "start");
    if (answer.length === 0 || question.trim().length === 0)
      return Option.none<SidequestAd | null>();
    const response = yield* send("fetch-ad", "POST", "/api/ad", deviceKey, {
      placement: "inline",
      client: "t3code",
      question,
      answer,
      conversationId: clip(threadId, 64, "start"),
    });
    if (response.status === 204) return Option.some(null);
    if (response.status !== 200) return Option.none<SidequestAd | null>();
    return Option.some(Option.getOrNull(decodeAd(response.body)));
  });

  const fetchAd = Effect.fn("SidequestService.fetchAd")(
    function* (input: SidequestFetchAdInput) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.sidequestEnabled) return null;
      const device = yield* loadDevice;
      if (Option.isNone(device)) return null;
      const { deviceKey } = device.value;
      return yield* adLock.withPermits(1)(
        Effect.gen(function* () {
          const cached = (yield* Ref.get(cache)).get(input.runId);
          if (cached !== undefined) return cached.ad;
          const result = yield* requestAd(deviceKey, input);
          if (Option.isNone(result)) return null;
          yield* Ref.update(cache, (current) => {
            const next = new Map(current).set(input.runId, { ad: result.value, reported: false });
            const oldest = next.keys().next();
            if (next.size > MAX_CACHED_RUNS && !oldest.done) next.delete(oldest.value);
            return next;
          });
          return result.value;
        }),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Sidequest ad fetch failed", { cause }).pipe(Effect.as(null)),
    ),
  );

  const setReported = (impressionId: string, reported: boolean) =>
    Ref.modify(cache, (current) => {
      const entry = [...current].find(([, value]) => value.ad?.impressionId === impressionId);
      if (entry === undefined || entry[1].reported === reported) return [false, current] as const;
      return [true, new Map(current).set(entry[0], { ad: entry[1].ad, reported })] as const;
    });

  const reportImpression = Effect.fn("SidequestService.reportImpression")(
    function* ({ impressionId }: SidequestReportImpressionInput) {
      const device = yield* loadDevice.pipe(Effect.option);
      if (Option.isNone(device) || Option.isNone(device.value)) return;
      if (!(yield* setReported(impressionId, true))) return;
      const delivered = yield* send(
        "impression",
        "POST",
        `/api/impression/${encodeURIComponent(impressionId)}`,
        device.value.value.deviceKey,
      ).pipe(
        Effect.flatMap(({ status }) =>
          isRetryableStatus(status) ? Effect.fail(status) : Effect.succeed(status),
        ),
        Effect.retry({
          times: IMPRESSION_RETRIES,
          schedule: Schedule.exponential("1 second"),
        }),
        Effect.option,
      );
      if (Option.isNone(delivered)) yield* setReported(impressionId, false);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Sidequest impression report failed", { cause }).pipe(Effect.asVoid),
    ),
  );

  return SidequestService.of({
    getConnection: deviceLock.withPermits(1)(getConnection()).pipe(Effect.orDie),
    connect: deviceLock.withPermits(1)(connect()).pipe(Effect.orDie),
    disconnect: deviceLock.withPermits(1)(disconnect()).pipe(Effect.orDie),
    fetchAd,
    reportImpression,
  });
});

export const layer = Layer.effect(SidequestService, make);
