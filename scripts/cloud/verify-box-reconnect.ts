/**
 * Proves a cloud chat's box reconnects by itself after its manager pauses it. The script runs the
 * web client's own connection stack (client-runtime `Connection.layerWithOptions`: registry,
 * supervisor, resolver, RPC session) in Node with in-memory platform services. The manager is
 * the platform's primary environment; the box is paired through `ConnectionOnboarding` the way
 * the web join flow saves it, as a bearer connection marked `box: { managerId }`.
 *
 *   node scripts/cloud/verify-box-reconnect.ts --origin http://127.0.0.1:<port> \
 *     --pairing-token-file .t3/manager/pairing-token --provider e2b --report ./reconnect.json
 *
 * It provisions one box, demands it like an open chat, waits for `connected`, pauses the box
 * through the manager, and then only watches: no retry, no resume. Every supervisor state change
 * of the box and the manager prints one line and lands in the report. `--dry-run` stops once the
 * box first connects. The box is disposed on every path, and the exit code is nonzero unless the
 * box came back.
 *
 * Presence comes from the same signals the web reports: the app's visibility, and an input when
 * the user opens the chat. `--reopen` closes the chat before the pause and opens it again after,
 * the way a user comes back to a paused chat, and fails unless a resume reaches the host within
 * 30 seconds of opening it. `--cut-host-mid-wake` reconnects the manager while the box's resume
 * is in flight, closing the session under it, and fails unless the box still comes back.
 *
 * `--second-client` proves a second device lists and opens a chat it never paired. Client A
 * provisions the box with a chat whose first turn the host starts, waits for the chat's thread,
 * closes it and pauses the box through the host. Client B, a fresh catalog paired only to the
 * host, follows the host's list: the chat is listed with A's thread and title. The chat is
 * unsettled and its user present, so the host wakes the box ahead of them while B never dials
 * it. B then opens the chat: it pairs once through the host and connects, and its thread loads.
 * A fresh runtime over B's storage opens it again with the same pairing, and after the box is
 * disposed B's sync stops dialing it.
 *
 * `--lease <leaseId>` runs client B against a chat that already exists, provisioning nothing and
 * disposing nothing. It finds the chat whose box is that lease in the host's list, checks it is
 * listed with its title while the box stays paused and undialed, opens it (the box wakes, pairs
 * once through the host and connects), checks the thread loads with its messages, sends one turn
 * the way the web composer starts one, and waits for a reply and a settled run. A box made on an
 * older runtime must come back on the host's pinned build: the client never sees an unsupported
 * protocol, and the box's descriptor afterwards reports protocol 2. Each check lands in `checks`.
 *
 * The manager bearer is cached beside the pairing token (0600), shared with smoke-cloud-chat.ts.
 * Tokens and pairing URLs never reach stdout or the report; URLs in failure details lose their
 * query and fragment.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { TokenStore, bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  Connection,
  ConnectionBlockedError,
  ConnectionOnboarding,
  Connectivity,
  CredentialStore,
  EnvironmentRegistry,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  ProfileStore,
  type SupervisorConnectionState,
  Presence,
  Wakeups,
  provisionedGatewayPairingUrl,
  connectionRoutes,
} from "@t3tools/client-runtime/connection";
import {
  deriveWsBaseUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime/environment";
import {
  ClientCapabilities,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  Persistence,
  PlatformConnectionSource,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
} from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import * as RpcHttp from "@t3tools/client-runtime/rpc";
import { provisionedBox } from "@t3tools/client-runtime/cloud";
import { startThreadTurn } from "@t3tools/client-runtime/operations";
import {
  AuthStandardClientScopes,
  type EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type ProvisionedEnvironment,
  ProvisionRequestId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Command, Flag } from "effect/cli";

import { advanceTurn, initialProgress } from "./turnProgress.ts";

const MANAGER_CONNECT_TIMEOUT = "1 minute";
const PROVISION_TIMEOUT = "20 minutes";
const BOX_CONNECT_TIMEOUT = "3 minutes";
const CALL_TIMEOUT = "2 minutes";
const DISPOSE_TIMEOUT = "3 minutes";
const WAKE_AFTER_OPEN_TIMEOUT = "30 seconds";
const CLIENT_METADATA = { label: "box reconnect verifier", deviceType: "bot" } as const;
const SECOND_CLIENT_CHAT_TITLE = "Second client proof";
/** How long the `--lease` client waits without opening the chat, to show listing it dials nothing. */
const SECOND_CLIENT_IDLE = "10 seconds";
const LEASE_TURN_TIMEOUT = "10 minutes";
const LEASE_TURN_PROMPT = "Reply with the single word: continued.";

class VerifyFailure extends Schema.TaggedError<VerifyFailure>()("VerifyFailure", {
  message: Schema.String,
}) {}

const Transition = Schema.Struct({
  environment: Schema.Literals(["manager", "box", "second-box"]),
  at: Schema.String,
  seconds: Schema.Finite,
  afterPause: Schema.Boolean,
  phase: Schema.String,
  stage: Schema.NullOr(Schema.String),
  attempt: Schema.Finite,
  generation: Schema.Finite,
  failure: Schema.NullOr(
    Schema.Struct({ tag: Schema.String, reason: Schema.String, detail: Schema.String }),
  ),
  retryInSeconds: Schema.NullOr(Schema.Finite),
});
type Transition = typeof Transition.Type;

const Outcome = Schema.Literals([
  "reconnected",
  "not-reconnected",
  "connected-dry-run",
  "second-client-opened",
  "existing-chat-continued",
  "failed",
]);
type Outcome = typeof Outcome.Type;

const Check = Schema.Struct({
  name: Schema.String,
  pass: Schema.Boolean,
  value: Schema.NullOr(Schema.Union([Schema.Finite, Schema.String])),
  evidence: Schema.Unknown,
});
type Check = typeof Check.Type;

const encodeReport = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      harness: Schema.Literal("verify-box-reconnect"),
      startedAt: Schema.String,
      finishedAt: Schema.String,
      origin: Schema.String,
      provider: Schema.String,
      dryRun: Schema.Boolean,
      timeoutMinutes: Schema.Finite,
      awaySeconds: Schema.Finite,
      wokeWhileAway: Schema.Boolean,
      reopen: Schema.Boolean,
      cutHostMidWake: Schema.Boolean,
      cutInFlight: Schema.NullOr(Schema.Boolean),
      secondClient: Schema.Boolean,
      lease: Schema.NullOr(Schema.String),
      box: Schema.NullOr(
        Schema.Struct({
          requestId: Schema.String,
          environmentId: Schema.String,
          leaseId: Schema.String,
          sandboxId: Schema.String,
          profileHttpOrigin: Schema.NullOr(Schema.String),
        }),
      ),
      pausedAtSeconds: Schema.NullOr(Schema.Finite),
      reconnectedAfterPauseSeconds: Schema.NullOr(Schema.Finite),
      phasesAfterPause: Schema.Array(Schema.String),
      outcome: Outcome,
      ok: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
      disposed: Schema.NullOr(Schema.String),
      checks: Schema.Array(Check),
      transitions: Schema.Array(Transition),
    }),
    { space: 2 },
  ),
);

const BearerCache = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.String, accessToken: Schema.String, expiresAt: Schema.Finite }),
);
const decodeBearerCache = Schema.decodeUnknownEffect(BearerCache);
const encodeBearerCache = Schema.encodeEffect(BearerCache);

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));
/** Drops every URL's query and fragment, where tickets and pairing credentials travel. */
const redact = (text: string) =>
  text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>?#]*[^\s"'<>]*/g, (url) =>
    url.replace(/[?#].*$/, ""),
  );
const describe = (cause: unknown) => redact(hasMessage(cause) ? cause.message : String(cause));

const isVerifyFailure = Schema.is(VerifyFailure);
const bounded = <A, E, R>(self: Effect.Effect<A, E, R>, what: string) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () =>
        Effect.fail(new VerifyFailure({ message: `${what}: no answer in ${CALL_TIMEOUT}` })),
    }),
    Effect.mapError((cause) =>
      isVerifyFailure(cause)
        ? cause
        : new VerifyFailure({ message: `${what}: ${describe(cause)}` }),
    ),
  );

interface Options {
  readonly origin: string;
  readonly pairingTokenFile: string;
  readonly provider: "e2b" | "namespace";
  readonly timeoutMinutes: number;
  readonly report: string;
  readonly dryRun: boolean;
  readonly awaySeconds: number;
  readonly reopen: boolean;
  readonly cutHostMidWake: boolean;
  readonly secondClient: boolean;
  readonly lease: string | null;
}

const managerBearer = Effect.fn("managerBearer")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem;
  const cachePath = `${options.pairingTokenFile}.bearer.json`;
  const now = yield* Clock.currentTimeMillis;
  const cached = yield* fs
    .readFileString(cachePath)
    .pipe(Effect.flatMap(decodeBearerCache), Effect.option);
  if (
    Option.isSome(cached) &&
    cached.value.origin === options.origin &&
    cached.value.expiresAt - now > 15 * 60_000
  )
    return cached.value.accessToken;
  const credential = (yield* fs.readFileString(options.pairingTokenFile)).trim();
  const token = yield* bounded(
    bootstrapRemoteBearerSession({
      httpBaseUrl: options.origin,
      credential,
      clientMetadata: CLIENT_METADATA,
    }),
    "manager token exchange",
  );
  yield* fs.writeFileString(
    cachePath,
    yield* encodeBearerCache({
      origin: options.origin,
      accessToken: token.access_token,
      expiresAt: now + token.expires_in * 1000,
    }),
    { mode: 0o600 },
  );
  yield* fs.chmod(cachePath, 0o600);
  return token.access_token;
});

/** The web's IndexedDB catalog, in memory: one document that every store reads and updates. */
const memoryStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* Ref.make(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    const read = Ref.get(catalog);
    const update = (
      change: (
        document: typeof EMPTY_CONNECTION_CATALOG_DOCUMENT,
      ) => typeof EMPTY_CONNECTION_CATALOG_DOCUMENT,
    ) => Ref.update(catalog, change);
    const targets = Persistence.ConnectionTargetStore.of({
      list: Effect.map(read, (document) => document.targets),
      listDisabled: Effect.map(read, (document) => document.disabledEnvironmentIds),
    });
    const registrations = Persistence.ConnectionRegistrationStore.of({
      register: (registration, routes) =>
        update((document) => registerConnectionInCatalog(document, registration, routes)),
      setRoutes: (environmentId, routes) =>
        update((document) => setRoutesInCatalog(document, environmentId, routes)),
      remove: (environmentId) =>
        update((document) => removeConnectionFromCatalog(document, environmentId)),
      setEnabled: (environmentId, enabled) =>
        update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled)),
    });
    const profiles = ProfileStore.make({
      get: (connectionId) =>
        Effect.map(read, (document) =>
          Option.fromUndefinedOr(
            document.profiles.find((profile) => profile.connectionId === connectionId),
          ),
        ),
      put: (profile) =>
        update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentials = CredentialStore.make({
      get: (connectionId) =>
        Effect.map(read, (document) =>
          Option.fromUndefinedOr(
            document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
          ),
        ),
      put: (connectionId, credential) =>
        update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokens = TokenStore.make({
      get: (environmentId) =>
        Effect.map(read, (document) =>
          Option.fromUndefinedOr(
            document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
          ),
        ),
      put: (token) => update((document) => putRemoteDpopTokenInCatalog(document, token)),
      remove: (environmentId) =>
        update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    // Shells are kept so a second client's seeded chat can be read back; the rest is a startup
    // cache a fresh process has none of.
    const shells = yield* Ref.make<ReadonlyMap<EnvironmentId, OrchestrationV2ShellSnapshot>>(
      new Map(),
    );
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        Effect.map(Ref.get(shells), (current) =>
          Option.fromUndefinedOr(current.get(environmentId)),
        ),
      saveShell: (environmentId, snapshot) =>
        Ref.update(shells, (current) => new Map(current).set(environmentId, snapshot)),
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: (environmentId) =>
        Ref.update(shells, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        }),
    });
    return Context.make(Persistence.ConnectionTargetStore, targets).pipe(
      Context.add(Persistence.ConnectionRegistrationStore, registrations),
      Context.add(ProfileStore.ConnectionProfileStore, profiles),
      Context.add(CredentialStore.ConnectionCredentialStore, credentials),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokens),
      Context.add(Persistence.EnvironmentCacheStore, cache),
    );
  }),
);

const unavailable = (detail: string) =>
  new ConnectionBlockedError({ reason: "unsupported", detail });
const notSignedIn = () => Effect.die("This verifier is not signed in to T3 Connect.");

/**
 * Not signed in to T3 Connect, no SSH, always online, never backgrounded. Presence is fed what
 * the web feeds it: `visible` is the document's visibility, and `inputs` the user's clicks.
 */
const platformLayer = (
  manager: PrimaryConnectionRegistration,
  bearer: string,
  visible: Queue.Queue<boolean>,
  inputs: Queue.Queue<void>,
  storage: typeof memoryStorageLayer,
) =>
  Layer.mergeAll(
    storage,
    Presence.layer({ visible: Stream.fromQueue(visible), inputs: Stream.fromQueue(inputs) }),
    NodeSocket.layerWebSocketConstructor,
    Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
    Wakeups.layer({ changes: Stream.never }),
    Layer.succeed(
      PlatformConnectionSource.PlatformConnectionSource,
      PlatformConnectionSource.PlatformConnectionSource.of({
        registrations: Stream.make([manager]),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeedSome(bearer) }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: CLIENT_METADATA,
        scopes: AuthStandardClientScopes,
      }),
    ),
    Layer.succeed(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.succeedNone,
        clerkToken: Effect.fail(
          new ConnectionBlockedError({
            reason: "authentication",
            detail: "Not signed in to T3 Connect.",
          }),
        ),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.RelayDeviceIdentity,
      ClientCapabilities.RelayDeviceIdentity.of({ deviceId: Effect.succeedNone }),
    ),
    Layer.succeed(
      ClientCapabilities.SshEnvironmentGateway,
      ClientCapabilities.SshEnvironmentGateway.of({
        provision: () => Effect.fail(unavailable("No SSH in this verifier.")),
        prepare: () => Effect.fail(unavailable("No SSH in this verifier.")),
        disconnect: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ManagedRelay.ManagedRelayDpopSigner,
      ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: notSignedIn(),
        createProof: notSignedIn,
      }),
    ),
    Layer.succeed(
      ManagedRelay.ManagedRelayClient,
      ManagedRelay.ManagedRelayClient.of({
        relayUrl: "http://relay.invalid",
        listEnvironments: notSignedIn,
        listDevices: notSignedIn,
        createEnvironmentLinkChallenge: notSignedIn,
        linkEnvironment: notSignedIn,
        unlinkEnvironment: notSignedIn,
        getEnvironmentStatus: notSignedIn,
        connectEnvironment: notSignedIn,
        registerDevice: notSignedIn,
        unregisterDevice: notSignedIn,
        registerLiveActivity: notSignedIn,
        getAgentActivitySnapshot: notSignedIn,
        resetTokenCache: Effect.void,
      }),
    ),
  );

/** One client runtime. Pass the same `storage` to run a fresh runtime over a saved catalog. */
const clientLayer = (
  manager: PrimaryConnectionRegistration,
  bearer: string,
  visible: Queue.Queue<boolean>,
  inputs: Queue.Queue<void>,
  storage: typeof memoryStorageLayer = memoryStorageLayer,
) =>
  Connection.layerWithOptions({
    environmentThemes: true,
    usageLimitSources: true,
    usageLimitsCommand: true,
  }).pipe(Layer.provideMerge(platformLayer(manager, bearer, visible, inputs, storage)));

const verify = Effect.fn("verifyBoxReconnect")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const runStart = yield* Clock.currentTimeMillis;
  const elapsed = Effect.map(
    Clock.currentTimeMillis,
    (now) => Math.round((now - runStart) / 100) / 10,
  );

  const log = yield* SubscriptionRef.make<ReadonlyArray<Transition>>([]);
  const visible = yield* Queue.unbounded<boolean>();
  const inputs = yield* Queue.unbounded<void>();
  yield* Queue.offer(visible, true);
  let wokeWhileAway = false;
  // Whether --cut-host-mid-wake closed the manager's session while the resume was in flight.
  let cutInFlight: boolean | null = null;
  const pausedAt = yield* Ref.make<number | null>(null);
  const created: {
    requestId: ProvisionRequestId | null;
    box: ProvisionedEnvironment | null;
    profileHttpOrigin: string | null;
  } = { requestId: null, box: null, profileHttpOrigin: null };
  // Assigned inside the run's generator, so the type is widened by hand.
  let outcome = "failed" as Outcome;
  let error: string | null = null;
  let disposed: string | null = null;
  const checks: Array<Check> = [];

  const record = (environment: Transition["environment"], state: SupervisorConnectionState) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const paused = yield* Ref.get(pausedAt);
      const failure = state.lastFailure;
      const transition: Transition = {
        environment,
        at: DateTime.formatIso(DateTime.makeUnsafe(now)),
        seconds: yield* elapsed,
        afterPause: paused !== null,
        phase: state.phase,
        stage: state.stage,
        attempt: state.attempt,
        generation: state.generation,
        failure:
          failure === null
            ? null
            : { tag: failure._tag, reason: failure.reason, detail: redact(failure.detail) },
        retryInSeconds:
          state.retryAt === null ? null : Math.max(0, Math.round((state.retryAt - now) / 1000)),
      };
      const previous = (yield* SubscriptionRef.get(log)).findLast(
        (entry) => entry.environment === environment,
      );
      const same =
        previous !== undefined &&
        previous.phase === transition.phase &&
        previous.stage === transition.stage &&
        previous.attempt === transition.attempt &&
        previous.generation === transition.generation &&
        previous.failure?.detail === transition.failure?.detail;
      if (same) return;
      const sincePause =
        paused === null ? "" : ` (+${Math.round((now - paused) / 100) / 10}s after pause)`;
      yield* Console.log(
        [
          `[${transition.seconds}s]${sincePause} ${environment} ${transition.phase}`,
          transition.stage === null ? "" : `stage=${transition.stage}`,
          `attempt=${transition.attempt} generation=${transition.generation}`,
          transition.failure === null
            ? ""
            : `failure=${transition.failure.tag}/${transition.failure.reason}: ${transition.failure.detail}`,
          transition.retryInSeconds === null ? "" : `retry in ${transition.retryInSeconds}s`,
        ]
          .filter((part) => part !== "")
          .join(" "),
      );
      // After the print: a waiter that wakes on this entry may close the scope this runs in.
      yield* SubscriptionRef.update(log, (entries) => [...entries, transition]);
    });

  const waitFor = (
    what: string,
    duration: Duration.Input,
    done: (entries: ReadonlyArray<Transition>) => boolean,
  ) =>
    SubscriptionRef.changes(log).pipe(
      Stream.filter(done),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            new VerifyFailure({
              message: `${what}: not within ${Duration.format(Duration.fromInputUnsafe(duration))}`,
            }),
          ),
      }),
    );
  const lastOf = (entries: ReadonlyArray<Transition>, environment: Transition["environment"]) =>
    entries.findLast((entry) => entry.environment === environment);

  const check = (ok: boolean, message: string) =>
    ok ? Effect.void : Effect.fail(new VerifyFailure({ message }));

  /** Records a named check in the report, then stops the run when it failed. */
  const checked = (name: string, pass: boolean, value: Check["value"], evidence: unknown = null) =>
    Effect.gen(function* () {
      checks.push({ name, pass, value, evidence });
      yield* Console.log(`[${yield* elapsed}s] ${pass ? "PASS" : "FAIL"} ${name} ${value ?? ""}`);
      if (!pass) return yield* new VerifyFailure({ message: `${name}: ${value ?? "failed"}` });
    });

  /** The title of a chat's thread as the box serves it, once the box has the thread. */
  const threadTitle = (
    registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
    boxId: EnvironmentId,
    threadId: ThreadId,
    what: string,
  ) =>
    bounded(
      registry
        .runStream(boxId, subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId }))
        .pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.flatMap((item) =>
            Option.isSome(item) &&
            item.value.kind === "snapshot" &&
            item.value.projection.thread.id === threadId
              ? Effect.succeed(item.value.projection.thread.title)
              : Effect.fail(new VerifyFailure({ message: `${what}: no snapshot of the thread` })),
          ),
          Effect.retry(Schedule.spaced("5 seconds")),
        ),
      what,
    );

  const listOnHost = (
    registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
    managerId: EnvironmentId,
  ) =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.get(registry.entries);
      return yield* bounded(
        registry.run(
          managerId,
          request(WS_METHODS.environmentControlListProvisioned, {
            environmentIds: [...entries.keys()],
            chats: [],
          }),
        ),
        "list the host's boxes",
      );
    });

  const awaitManager = (
    registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
    managerId: EnvironmentId,
  ) =>
    registry.stateChanges(managerId).pipe(
      Stream.filter((state) => state.phase === "connected"),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: MANAGER_CONNECT_TIMEOUT,
        orElse: () =>
          Effect.fail(new VerifyFailure({ message: "client B: manager not connected" })),
      }),
    );

  /**
   * Client B: a fresh catalog paired only to the host. It lists the chat from the host, leaves
   * the box undialed while the host wakes it ahead of the present user, opens it (one pairing,
   * connect), opens it again from a fresh runtime over the same storage with that pairing, and
   * stops dialing it once it is disposed.
   */
  const verifySecondClient = Effect.fn("verifySecondClient")(function* (input: {
    readonly manager: PrimaryConnectionRegistration;
    readonly bearer: string;
    readonly managerId: EnvironmentId;
    readonly boxId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly title: string;
  }) {
    const { managerId, boxId, threadId } = input;
    // Built fresh, and provided `local`, or the memo map hands client B client A's storage and
    // registry, with the box A paired.
    const storage = Layer.succeedContext(yield* Layer.build(Layer.fresh(memoryStorageLayer)));
    const visibleB = yield* Queue.unbounded<boolean>();
    const inputsB = yield* Queue.unbounded<void>();
    yield* Queue.offer(visibleB, true);
    const clientB = clientLayer(input.manager, input.bearer, visibleB, inputsB, storage);
    // A box can be reached over several routes, each with its own saved pairing.
    const credentialToken = Effect.gen(function* () {
      const credentials = yield* CredentialStore.ConnectionCredentialStore;
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(boxId);
      for (const route of entry ? connectionRoutes(entry) : []) {
        const credential = yield* credentials.get(route.target.connectionId);
        if (Option.isSome(credential)) return credential.value.token;
      }
      return null;
    });

    const firstToken = yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const cache = yield* Persistence.EnvironmentCacheStore;
      yield* awaitManager(registry, managerId);
      const rows = yield* listOnHost(registry, managerId);
      const row = rows.find((candidate) => candidate.environmentId === boxId);
      // The host may already be waking it for client A, who is still present.
      yield* check(
        row?.lifecycle === "paused" || row?.lifecycle === "active",
        `client B: the host lists the box ${row?.lifecycle}`,
      );
      yield* check(
        row?.chat?.thread.id === threadId && row.chat.thread.title === input.title,
        `client B: the host lists the chat as ${row?.chat?.thread.id ?? "none"} "${row?.chat?.thread.title ?? ""}"`,
      );
      yield* registry.syncHostBoxes(
        managerId,
        rows.map((candidate) => provisionedBox(managerId, candidate)),
      );
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(boxId);
      yield* check(
        entry !== undefined &&
          Option.isNone(entry.profile) &&
          entry.target._tag === "BearerConnectionTarget" &&
          entry.target.box?.managerId === managerId,
        "client B: the box is not saved unpaired",
      );
      const seeded = yield* cache.loadShell(boxId);
      yield* check(
        Option.exists(seeded, (shell) => shell.threads.some(({ id }) => id === threadId)),
        "client B: the chat is not in the box's cached shell",
      );
      yield* Console.log(
        `[${yield* elapsed}s] client B lists the chat "${input.title}" on ${entry?.target.label}`,
      );

      yield* registry.stateChanges(boxId).pipe(
        Stream.runForEach((state) => record("second-box", state)),
        Effect.forkScoped,
      );
      const woken = yield* listOnHost(registry, managerId).pipe(
        Effect.map(
          (listed) => listed.find((candidate) => candidate.environmentId === boxId)?.lifecycle,
        ),
        Effect.repeat({
          while: (lifecycle) => lifecycle !== "active",
          schedule: Schedule.spaced("5 seconds"),
        }),
        Effect.timeoutOption(Duration.minutes(options.timeoutMinutes)),
      );
      yield* check(
        Option.isSome(woken),
        "client B: the host did not wake the unsettled chat's box",
      );
      // The box may already be active on B's first list, so watch B for a while after the wake
      // before judging that it never dialed the chat it did not open.
      yield* Effect.sleep(SECOND_CLIENT_IDLE);
      const idle = (yield* SubscriptionRef.get(log)).filter(
        (entry) => entry.environment === "second-box",
      );
      yield* check(idle.length > 0, "client B recorded no state for the box it lists");
      yield* check(
        idle.every((entry) => entry.phase === "available"),
        `client B dialed a chat it did not open: ${idle.map((entry) => entry.phase).join(", ")}`,
      );
      yield* Console.log(`[${yield* elapsed}s] the host woke the chat's box ahead of client B`);

      const openedAt = (yield* SubscriptionRef.get(log)).length;
      yield* Queue.offer(inputsB, undefined);
      yield* registry.demand(boxId);
      yield* Console.log(`[${yield* elapsed}s] client B opens the chat`);
      yield* waitFor("client B's box connected", BOX_CONNECT_TIMEOUT, (entries) =>
        entries
          .slice(openedAt)
          .some((entry) => entry.environment === "second-box" && entry.phase === "connected"),
      );
      yield* check(
        (yield* threadTitle(registry, boxId, threadId, "client B loads the chat")) === input.title,
        "client B: the chat's thread does not match client A's",
      );
      const token = yield* credentialToken;
      yield* check(token !== null, "client B: no pairing saved for the box");
      return token;
    }).pipe(Effect.scoped, Effect.provide(clientB, { local: true }));

    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* awaitManager(registry, managerId);
      const openedAt = (yield* SubscriptionRef.get(log)).length;
      yield* registry.stateChanges(boxId).pipe(
        Stream.runForEach((state) => record("second-box", state)),
        Effect.forkScoped,
      );
      yield* registry.demand(boxId);
      yield* waitFor("client B reopens the box", BOX_CONNECT_TIMEOUT, (entries) =>
        entries
          .slice(openedAt)
          .some((entry) => entry.environment === "second-box" && entry.phase === "connected"),
      );
      yield* check(
        (yield* credentialToken) === firstToken,
        "client B paired the box again after a restart",
      );
      yield* Console.log(`[${yield* elapsed}s] client B reopened the chat with its saved pairing`);

      yield* dispose(registry, managerId);
      yield* registry.syncHostBoxes(
        managerId,
        (yield* listOnHost(registry, managerId)).map((candidate) =>
          provisionedBox(managerId, candidate),
        ),
      );
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(boxId);
      yield* check(
        entry === undefined ||
          (entry.target._tag === "BearerConnectionTarget" &&
            entry.target.workspaceStatus === "missing"),
        "client B still dials the disposed box",
      );
    }).pipe(Effect.scoped, Effect.provide(clientB, { local: true }));
  }, Effect.scoped);

  /**
   * Client B on a chat that already exists: lists it from the host without dialing its paused
   * box, opens it, reads its history, and continues it with one turn.
   */
  const continueExistingChat = Effect.fn("continueExistingChat")(function* (
    registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
    managerId: EnvironmentId,
    leaseId: string,
  ) {
    const cache = yield* Persistence.EnvironmentCacheStore;
    const credentials = yield* CredentialStore.ConnectionCredentialStore;
    const rows = yield* listOnHost(registry, managerId);
    const row = rows.find((candidate) => candidate.leaseId === leaseId);
    yield* checked("lease.listed", row !== undefined, row?.lifecycle ?? null, {
      environmentId: row?.environmentId ?? null,
      provider: row?.provider ?? null,
    });
    const boxId = row!.environmentId;
    // A paused chat, or an active one whose guest server died, must both open and wake.
    const lifecycle = row!.lifecycle;
    yield* checked("lease.lifecycle", lifecycle === "paused" || lifecycle === "active", lifecycle);
    const chat = row!.chat;
    yield* checked(
      "lease.chatListed",
      chat !== undefined && (row!.threadId === null || chat.thread.id === row!.threadId),
      chat?.thread.title ?? null,
      { threadId: chat?.thread.id ?? null },
    );
    const threadId = chat!.thread.id;
    const title = chat!.thread.title;

    yield* registry.syncHostBoxes(
      managerId,
      rows.map((candidate) => provisionedBox(managerId, candidate)),
    );
    const listed = (yield* SubscriptionRef.get(registry.entries)).get(boxId);
    yield* checked(
      "lease.savedUnpaired",
      listed !== undefined &&
        Option.isNone(listed.profile) &&
        listed.target._tag === "BearerConnectionTarget" &&
        listed.target.box?.managerId === managerId,
      listed?.target._tag ?? null,
    );
    const seeded = yield* cache.loadShell(boxId);
    yield* checked(
      "lease.cachedShell",
      Option.exists(seeded, (shell) => shell.threads.some(({ id }) => id === threadId)),
      Option.match(seeded, { onNone: () => null, onSome: (shell) => shell.threads.length }),
    );

    yield* registry.stateChanges(boxId).pipe(
      Stream.runForEach((state) => record("box", state)),
      Effect.forkScoped,
    );
    yield* Effect.sleep(SECOND_CLIENT_IDLE);
    const idle = (yield* SubscriptionRef.get(log)).filter((entry) => entry.environment === "box");
    yield* checked(
      "lease.undialed",
      idle.every((entry) => entry.phase === "available"),
      [...new Set(idle.map((entry) => entry.phase))].join(","),
    );
    const relisted = yield* listOnHost(registry, managerId);
    const stillPaused = relisted.find((candidate) => candidate.leaseId === leaseId)?.lifecycle;
    yield* checked("lease.lifecycleUnchanged", stillPaused === lifecycle, stillPaused ?? null);

    const openedAt = (yield* SubscriptionRef.get(log)).length;
    const openedAtSeconds = yield* elapsed;
    yield* Queue.offer(inputs, undefined);
    yield* registry.demand(boxId);
    yield* Console.log(`[${openedAtSeconds}s] client B opens the chat`);
    yield* waitFor(
      "the chat's box connected",
      Duration.minutes(options.timeoutMinutes),
      (entries) =>
        entries
          .slice(openedAt)
          .some((entry) => entry.environment === "box" && entry.phase === "connected"),
    );
    const opened = (yield* SubscriptionRef.get(log))
      .slice(openedAt)
      .filter((entry) => entry.environment === "box");
    const phases = opened.map((entry) => entry.phase);
    yield* checked(
      "lease.woke",
      phases.includes("waking") && phases.indexOf("waking") < phases.indexOf("connected"),
      Math.round(
        ((opened.find((entry) => entry.phase === "connected")?.seconds ?? 0) - openedAtSeconds) *
          10,
      ) / 10,
      { phases: [...new Set(phases)] },
    );
    const blocked = opened.filter((entry) => entry.failure?.reason === "unsupported");
    yield* checked("lease.protocolAccepted", blocked.length === 0, blocked.length, {
      failures: blocked.map((entry) => entry.failure),
    });
    const credential = yield* credentials.get(`bearer:${boxId}`);
    yield* checked(
      "lease.paired",
      Option.isSome(credential),
      Option.isSome(credential) ? "saved" : null,
    );

    const profile = Option.getOrUndefined(
      (yield* SubscriptionRef.get(registry.entries)).get(boxId)?.profile ?? Option.none(),
    );
    const descriptor =
      profile?._tag === "BearerConnectionProfile"
        ? yield* bounded(
            fetchRemoteEnvironmentDescriptor({ httpBaseUrl: profile.httpBaseUrl }),
            "box descriptor",
          )
        : null;
    // A descriptor without the field comes from a server older than protocol negotiation.
    const protocol = descriptor === null ? null : (descriptor.orchestrationProtocolVersion ?? 1);
    yield* checked("lease.descriptorAfter", protocol === 2, protocol, {
      serverVersion: descriptor?.serverVersion ?? null,
      orchestrationProtocolVersion: protocol,
    });

    const history = yield* bounded(
      registry
        .runStream(boxId, subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId }))
        .pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
        ),
      "load the chat",
    );
    const projection =
      Option.isSome(history) && history.value.kind === "snapshot" ? history.value.projection : null;
    const count = (role: "user" | "assistant") =>
      projection?.messages.filter((message) => message.role === role).length ?? 0;
    yield* checked(
      "lease.threadLoaded",
      projection !== null &&
        projection.thread.title === title &&
        count("user") > 0 &&
        count("assistant") > 0,
      `${count("user")} user, ${count("assistant")} assistant`,
      {
        userMessages: count("user"),
        assistantMessages: count("assistant"),
        runs: projection?.runs.length ?? 0,
      },
    );

    const messageId = MessageId.make(yield* crypto.randomUUIDv4);
    const sentAt = yield* Clock.currentTimeMillis;
    yield* bounded(
      registry.run(
        boxId,
        startThreadTurn({
          threadId,
          creationSource: "web",
          message: { messageId, role: "user", text: LEASE_TURN_PROMPT, attachments: [] },
          runtimeMode: projection!.thread.runtimeMode,
          interactionMode: projection!.thread.interactionMode,
          dispatchMode: "start",
        }),
      ),
      "send a turn",
    ).pipe(
      Effect.catchTags({
        VerifyFailure: (failure) => checked("lease.dispatch", false, failure.message),
      }),
    );
    yield* checked("lease.dispatch", true, "message.dispatch");

    let progress = initialProgress;
    const watched = yield* registry
      .runStream(boxId, subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId }))
      .pipe(
        Stream.runForEachWhile((item) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              progress = advanceTurn(progress, item, messageId, now);
              return progress.completedAt === null;
            }),
          ),
        ),
        Effect.timeoutOption(LEASE_TURN_TIMEOUT),
        Effect.map((finished) => (Option.isSome(finished) ? null : "turn did not finish in time")),
        Effect.catch((cause) => Effect.succeed(describe(cause))),
      );
    const reply = [...progress.assistant.values()].join("\n");
    const toSeconds = (at: number | null) =>
      at === null ? null : Math.round((at - sentAt) / 100) / 10;
    const run = progress.projection?.runs.findLast((entry) => entry.userMessageId === messageId);
    const replied = progress.firstOutputAt !== null;
    const settled = progress.completedAt !== null && progress.error === null;
    checks.push(
      {
        name: "lease.reply",
        pass: replied,
        value: toSeconds(progress.firstOutputAt),
        evidence: { replyTail: reply.slice(-200) },
      },
      {
        name: "lease.runSettled",
        pass: settled,
        value: run?.status ?? null,
        evidence: { seconds: toSeconds(progress.completedAt), error: progress.error ?? watched },
      },
    );
    yield* Console.log(
      `[${yield* elapsed}s] ${replied ? "PASS" : "FAIL"} lease.reply; ${settled ? "PASS" : "FAIL"} lease.runSettled ${run?.status ?? ""}`,
    );
    if (!replied || !settled)
      return yield* new VerifyFailure({
        message: `lease turn: ${progress.error ?? watched ?? run?.status ?? "no reply"}`,
      });
  }, Effect.scoped);

  const run = Effect.gen(function* () {
    const bearer = yield* managerBearer(options);
    const descriptor = yield* bounded(
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: options.origin }),
      "manager descriptor",
    );
    const managerId = descriptor.environmentId;
    yield* Console.log(
      `manager ${managerId} (${descriptor.label}) serverVersion=${descriptor.serverVersion}`,
    );
    const manager = new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: managerId,
        label: descriptor.label,
        httpBaseUrl: options.origin,
        wsBaseUrl: deriveWsBaseUrl(options.origin),
      }),
    });

    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
      const follow = (environment: Transition["environment"], environmentId: EnvironmentId) =>
        registry.stateChanges(environmentId).pipe(
          Stream.runForEach((state) => record(environment, state)),
          Effect.forkScoped,
        );
      const onManager = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
        bounded(registry.run(managerId, effect), what);

      // Runs while the client runtime is still up, after the box's demand is released.
      yield* Effect.addFinalizer(() =>
        dispose(registry, managerId).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => void (disposed = `error: ${describe(Cause.squash(cause))}`)),
          ),
        ),
      );
      yield* SubscriptionRef.changes(registry.entries).pipe(
        Stream.filter((entries) => entries.has(managerId)),
        Stream.runHead,
      );
      yield* follow("manager", managerId);
      yield* waitFor(
        "manager connected",
        MANAGER_CONNECT_TIMEOUT,
        (entries) => lastOf(entries, "manager")?.phase === "connected",
      );
      if (options.lease !== null) {
        yield* continueExistingChat(registry, managerId, options.lease);
        outcome = "existing-chat-continued";
        return;
      }

      const config = yield* onManager("server.getConfig", request(WS_METHODS.serverGetConfig, {}));
      const instance = config.providers.find((provider) => provider.enabled);
      if (instance === undefined)
        return yield* new VerifyFailure({ message: "the manager has no enabled provider account" });
      const requestId = ProvisionRequestId.make(yield* crypto.randomUUIDv4);
      created.requestId = requestId;
      const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
      const model =
        instance.models.find((candidate) => candidate.isDefault === true) ?? instance.models[0];
      if (options.secondClient && model === undefined)
        return yield* new VerifyFailure({ message: "the manager's provider account has no model" });
      // The host starts this first turn on the box, so the box holds a chat without client A.
      const provisionChat =
        options.secondClient && model !== undefined
          ? {
              threadId,
              firstTurn: {
                messageId: MessageId.make(yield* crypto.randomUUIDv4),
                text: "Reply with the single word: ready.",
                title: SECOND_CLIENT_CHAT_TITLE,
                modelSelection: { instanceId: instance.instanceId, model: model.slug },
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              },
            }
          : undefined;
      yield* Console.log(
        `provisioning ${options.provider} box request=${requestId} account=${instance.instanceId}`,
      );
      const provisioned = yield* onManager(
        "environmentControl.provision",
        request(WS_METHODS.environmentControlProvision, {
          requestId,
          provider: options.provider,
          providerInstanceId: instance.instanceId,
          agentDriver: instance.driver,
          ...(provisionChat === undefined ? {} : { chat: provisionChat }),
        }),
      ).pipe(
        Effect.repeat({
          while: (result) => result.kind === "pending" || result.kind === "allocation_unknown",
          schedule: Schedule.spaced("5 seconds"),
        }),
        Effect.timeoutOrElse({
          duration: PROVISION_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new VerifyFailure({ message: `provision: not ready in ${PROVISION_TIMEOUT}` }),
            ),
        }),
      );
      if (provisioned.kind !== "ready")
        return yield* new VerifyFailure({
          message: `provision ${provisioned.kind}: ${"message" in provisioned ? provisioned.message : ""}`,
        });
      const box = provisioned.environment;
      created.box = box;
      yield* Console.log(
        `[${yield* elapsed}s] box ready environment=${box.environmentId} lease=${box.leaseId} sandbox=${box.sandboxId}`,
      );

      const attached = yield* onManager(
        "environmentControl.attach",
        request(WS_METHODS.environmentControlAttach, { requestId }),
      );
      if (attached.kind !== "attached")
        return yield* new VerifyFailure({ message: `attach refused: ${attached.message}` });
      if (attached.environmentId !== box.environmentId)
        return yield* new VerifyFailure({ message: "attach returned another environment" });
      const boxId = yield* bounded(
        onboarding.registerPairing({
          pairingUrl: provisionedGatewayPairingUrl(
            options.origin,
            box.leaseId,
            attached.pairingUrl,
          ),
          expectedEnvironmentId: box.environmentId,
          box: { managerId },
        }),
        "pair box",
      );
      const saved = (yield* SubscriptionRef.get(registry.entries)).get(boxId);
      const profile = saved === undefined ? undefined : Option.getOrUndefined(saved.profile);
      created.profileHttpOrigin =
        profile?._tag === "BearerConnectionProfile" ? redact(profile.httpBaseUrl) : null;
      yield* Console.log(
        `box saved as ${saved?.target._tag} managerId=${
          saved?.target._tag === "BearerConnectionTarget"
            ? (saved.target.box?.managerId ?? "none")
            : "none"
        } profile=${created.profileHttpOrigin}`,
      );

      yield* Effect.gen(function* () {
        const chat = yield* Scope.make();
        yield* registry.demand(boxId).pipe(Scope.provide(chat));
        yield* follow("box", boxId);
        yield* waitFor(
          "box connected",
          BOX_CONNECT_TIMEOUT,
          (entries) => lastOf(entries, "box")?.phase === "connected",
        );
        if (options.dryRun) {
          outcome = "connected-dry-run";
          return;
        }
        if (options.secondClient) {
          const title = yield* threadTitle(registry, boxId, threadId, "client A loads the chat");
          yield* Console.log(`[${yield* elapsed}s] client A has the chat "${title}"`);
          // Closed first, or client A's own demand would wake the box it pauses.
          yield* Scope.close(chat, Exit.void);
          // The host refuses to pause a box mid-turn, and the chat's first turn may still be running.
          const paused = yield* onManager(
            "environmentControl.pause",
            request(WS_METHODS.environmentControlPause, {
              leaseId: box.leaseId,
              sandboxId: box.sandboxId,
            }),
          ).pipe(
            Effect.repeat({
              while: (result) => result.kind === "refused",
              schedule: Schedule.spaced("5 seconds"),
            }),
            Effect.timeoutOption(Duration.minutes(3)),
          );
          if (Option.isNone(paused) || paused.value.kind !== "paused")
            return yield* new VerifyFailure({
              message: Option.match(paused, {
                onNone: () => "pause refused for 3 minutes",
                onSome: (result) => `pause ${result.kind}`,
              }),
            });
          yield* Ref.set(pausedAt, yield* Clock.currentTimeMillis);
          yield* Console.log(`[${yield* elapsed}s] client A closed the chat and paused its box`);
          yield* verifySecondClient({ manager, bearer, managerId, boxId, threadId, title });
          outcome = "second-client-opened";
          return;
        }

        if (options.awaySeconds > 0) {
          yield* Queue.offer(visible, false);
          yield* Console.log(`[${yield* elapsed}s] user leaves: the app is hidden`);
        }
        if (options.reopen) {
          yield* Scope.close(chat, Exit.void);
          yield* Console.log(`[${yield* elapsed}s] user closes the chat`);
        }
        if (options.cutHostMidWake)
          yield* SubscriptionRef.changes(log).pipe(
            Stream.filter((entries) =>
              entries.some(
                (entry) =>
                  entry.environment === "box" && entry.afterPause && entry.phase === "waking",
              ),
            ),
            Stream.runHead,
            // Long enough for the resume to be on the wire, short of the quickest resume (E2B, ~2.5 s).
            Effect.andThen(Effect.sleep("500 millis")),
            Effect.andThen(
              Effect.gen(function* () {
                cutInFlight = (yield* registry.state(boxId)).phase === "waking";
                if (cutInFlight) yield* registry.retryNow(managerId);
                yield* Console.log(
                  cutInFlight
                    ? `[${yield* elapsed}s] manager reconnected under the box's in-flight resume`
                    : `[${yield* elapsed}s] the resume finished before the manager could be cut`,
                );
              }),
            ),
            Effect.forkScoped,
          );
        const paused = yield* onManager(
          "environmentControl.pause",
          request(WS_METHODS.environmentControlPause, {
            leaseId: box.leaseId,
            sandboxId: box.sandboxId,
          }),
        );
        yield* Ref.set(pausedAt, yield* Clock.currentTimeMillis);
        yield* Console.log(
          `[${yield* elapsed}s] pause -> ${paused.kind}; watching without retry or resume`,
        );
        if (paused.kind !== "paused")
          return yield* new VerifyFailure({ message: `pause ${paused.kind}` });
        if (options.awaySeconds > 0) {
          yield* Effect.sleep(Duration.seconds(options.awaySeconds));
          wokeWhileAway = (yield* SubscriptionRef.get(log)).some(
            (entry) =>
              entry.environment === "box" &&
              entry.afterPause &&
              (entry.phase === "waking" || entry.phase === "connected"),
          );
          yield* Console.log(
            `[${yield* elapsed}s] user returns after ${options.awaySeconds}s away; woken while away: ${wokeWhileAway}`,
          );
          if (wokeWhileAway)
            return yield* new VerifyFailure({
              message: "the box was woken while its user was away",
            });
          yield* Queue.offer(visible, true);
        }
        if (options.reopen) {
          yield* Effect.sleep("10 seconds");
          const openedAt = (yield* SubscriptionRef.get(log)).length;
          yield* Queue.offer(inputs, undefined);
          yield* registry.demand(boxId);
          yield* Console.log(`[${yield* elapsed}s] user opens the chat`);
          yield* waitFor(
            "a resume sent after the chat was opened",
            WAKE_AFTER_OPEN_TIMEOUT,
            (entries) =>
              entries
                .slice(openedAt)
                .some((entry) => entry.environment === "box" && entry.phase === "waking"),
          );
        }
        const timeout = Duration.minutes(options.timeoutMinutes);
        const came = yield* waitFor("box reconnected after pause", timeout, (entries) => {
          const after = entries.filter((entry) => entry.environment === "box" && entry.afterPause);
          return (
            after.some((entry) => entry.phase !== "connected") &&
            after.at(-1)?.phase === "connected"
          );
        }).pipe(
          Effect.as(true),
          Effect.catchTags({
            VerifyFailure: (failure) => Effect.sync(() => ((error = failure.message), false)),
          }),
        );
        outcome = came ? "reconnected" : "not-reconnected";
      }).pipe(Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(manager, bearer, visible, inputs)));
  });

  /** Disposes the box on the manager, retrying while another lease operation holds it. */
  const dispose = Effect.fn("dispose")(function* (
    registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
    managerId: EnvironmentId,
  ) {
    if (created.requestId === null || disposed === "disposed") return;
    const input = created.box
      ? { leaseId: created.box.leaseId, sandboxId: created.box.sandboxId }
      : { requestId: created.requestId };
    const result = yield* bounded(
      registry.run(managerId, request(WS_METHODS.environmentControlDispose, input)),
      "dispose",
    ).pipe(
      Effect.catch((cause) => Effect.succeed({ kind: "error" as const, message: describe(cause) })),
      Effect.repeat({
        while: (result) => result.kind !== "disposed",
        schedule: Schedule.spaced("5 seconds"),
      }),
      Effect.timeoutOption(DISPOSE_TIMEOUT),
    );
    disposed = Option.isSome(result) ? result.value.kind : `not disposed in ${DISPOSE_TIMEOUT}`;
    yield* Console.log(`[${yield* elapsed}s] dispose -> ${disposed}`);
  });

  // Defects too: a runtime missing a service must still write the report.
  yield* run.pipe(
    Effect.catchCause((cause) => Effect.sync(() => void (error = describe(Cause.squash(cause))))),
  );

  const entries = yield* SubscriptionRef.get(log);
  const pause = yield* Ref.get(pausedAt);
  const afterPause = entries.filter((entry) => entry.environment === "box" && entry.afterPause);
  const pausedAtSeconds = pause === null ? null : Math.round((pause - runStart) / 100) / 10;
  const reconnect = outcome === "reconnected" ? afterPause.at(-1) : undefined;
  const ok =
    (outcome === "reconnected" && (!options.cutHostMidWake || cutInFlight === true)) ||
    (options.dryRun && outcome === "connected-dry-run") ||
    (options.secondClient && outcome === "second-client-opened") ||
    (options.lease !== null && outcome === "existing-chat-continued");
  const report = yield* encodeReport({
    harness: "verify-box-reconnect",
    startedAt,
    finishedAt: DateTime.formatIso(yield* DateTime.now),
    origin: options.origin,
    provider: options.provider,
    dryRun: options.dryRun,
    timeoutMinutes: options.timeoutMinutes,
    awaySeconds: options.awaySeconds,
    wokeWhileAway,
    reopen: options.reopen,
    cutHostMidWake: options.cutHostMidWake,
    cutInFlight,
    secondClient: options.secondClient,
    lease: options.lease,
    box:
      created.box && created.requestId
        ? {
            requestId: created.requestId,
            environmentId: created.box.environmentId,
            leaseId: created.box.leaseId,
            sandboxId: created.box.sandboxId,
            profileHttpOrigin: created.profileHttpOrigin,
          }
        : null,
    pausedAtSeconds,
    reconnectedAfterPauseSeconds:
      reconnect === undefined || pausedAtSeconds === null
        ? null
        : Math.round((reconnect.seconds - pausedAtSeconds) * 10) / 10,
    phasesAfterPause: [...new Set(afterPause.map((entry) => entry.phase))],
    outcome,
    ok,
    error,
    disposed,
    checks,
    transitions: entries,
  });
  yield* fs.makeDirectory(path.dirname(options.report), { recursive: true });
  yield* fs.writeFileString(options.report, `${report}\n`);
  yield* Console.log(
    `${ok ? "PASS" : "FAIL"} ${outcome}${error === null ? "" : `: ${error}`}; disposed=${disposed}; report: ${options.report}`,
  );
  if (!ok) process.exitCode = 1;
});

const command = Command.make(
  "verify-box-reconnect",
  {
    origin: Flag.String("origin").pipe(
      Flag.withDescription("Manager origin, e.g. http://127.0.0.1:3773"),
    ),
    pairingTokenFile: Flag.String("pairing-token-file").pipe(
      Flag.withDescription("File holding a manager pairing token; the bearer is cached beside it."),
    ),
    provider: Flag.Literals("provider", ["e2b", "namespace"]).pipe(Flag.withDefault("e2b")),
    timeoutMinutes: Flag.Int("timeout-minutes").pipe(
      Flag.withDescription("How long to wait for the box to come back after the pause."),
      Flag.withDefault(10),
    ),
    report: Flag.String("report").pipe(Flag.withDescription("Where to write the JSON report.")),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Stop once the box first connects; no pause."),
      Flag.withDefault(false),
    ),
    awaySeconds: Flag.Int("away-seconds").pipe(
      Flag.withDescription(
        "Hide the app as the box is paused and keep it hidden this long, checking nothing wakes the box, then come back.",
      ),
      Flag.withDefault(0),
    ),
    reopen: Flag.Boolean("reopen").pipe(
      Flag.withDescription(
        "Close the chat before the pause and open it 10 s after, requiring a resume within 30 s of opening.",
      ),
      Flag.withDefault(false),
    ),
    cutHostMidWake: Flag.Boolean("cut-host-mid-wake").pipe(
      Flag.withDescription(
        "Reconnect the manager while the box's resume is in flight, closing the session under it.",
      ),
      Flag.withDefault(false),
    ),
    secondClient: Flag.Boolean("second-client").pipe(
      Flag.withDescription(
        "Pause the box with a chat on it, then prove a second client paired only to the host lists the chat, leaves it undialed while the host wakes it, and opens it with one pairing.",
      ),
      Flag.withDefault(false),
    ),
    lease: Flag.String("lease").pipe(
      Flag.withDescription(
        "Open and continue the existing chat on this paused lease as a second client; provisions and disposes nothing.",
      ),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const lease = Option.getOrNull(flags.lease);
      if (
        lease !== null &&
        (flags.secondClient ||
          flags.dryRun ||
          flags.reopen ||
          flags.cutHostMidWake ||
          flags.awaySeconds > 0)
      )
        return yield* new VerifyFailure({
          message: "--lease runs alone: it continues an existing chat and provisions no box",
        });
      yield* verify({
        origin: new URL(flags.origin).origin,
        pairingTokenFile: path.resolve(flags.pairingTokenFile),
        provider: flags.provider,
        timeoutMinutes: flags.timeoutMinutes,
        report: path.resolve(flags.report),
        dryRun: flags.dryRun,
        awaySeconds: flags.awaySeconds,
        reopen: flags.reopen,
        cutHostMidWake: flags.cutHostMidWake,
        secondClient: flags.secondClient,
        lease,
      });
    }),
).pipe(
  Command.withDescription(
    "Proves a cloud chat's box reconnects by itself after a pause, through the client connection stack.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    // The runtime's own logs can carry socket URLs; the transition lines report what matters.
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, RpcHttp.layerRemoteHttpClient(globalThis.fetch)),
    ),
    NodeRuntime.runMain,
  );
}
