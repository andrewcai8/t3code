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
} from "@t3tools/client-runtime/connection";
import {
  deriveWsBaseUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime/environment";
import {
  ClientPresentation,
  CloudSession,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  EnvironmentCacheStore,
  PlatformConnectionSource,
  putRemoteDpopTokenInCatalog,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
  setConnectionEnabledInCatalog,
} from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { request, remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type EnvironmentId,
  type ProvisionedEnvironment,
  ProvisionRequestId,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Command, Flag } from "effect/unstable/cli";

const MANAGER_CONNECT_TIMEOUT = "1 minute";
const PROVISION_TIMEOUT = "20 minutes";
const BOX_CONNECT_TIMEOUT = "3 minutes";
const CALL_TIMEOUT = "2 minutes";
const DISPOSE_TIMEOUT = "3 minutes";
const CLIENT_METADATA = { label: "box reconnect verifier", deviceType: "bot" } as const;

class VerifyFailure extends Schema.TaggedError<VerifyFailure>()("VerifyFailure", {
  message: Schema.String,
}) {}

const Transition = Schema.Struct({
  environment: Schema.Literals(["manager", "box"]),
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

const Outcome = Schema.Literals(["reconnected", "not-reconnected", "connected-dry-run", "failed"]);
type Outcome = typeof Outcome.Type;

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
    const targets = ConnectionTargetStore.of({
      list: Effect.map(read, (document) => document.targets),
      listDisabled: Effect.map(read, (document) => document.disabledEnvironmentIds),
    });
    const registrations = ConnectionRegistrationStore.of({
      register: (registration) =>
        update((document) => registerConnectionInCatalog(document, registration)),
      remove: (target) => update((document) => removeConnectionFromCatalog(document, target)),
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
    // Snapshots are a startup cache; a fresh process has none and nothing reads them back.
    const cache = EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    return Context.make(ConnectionTargetStore, targets).pipe(
      Context.add(ConnectionRegistrationStore, registrations),
      Context.add(ProfileStore.ConnectionProfileStore, profiles),
      Context.add(CredentialStore.ConnectionCredentialStore, credentials),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokens),
      Context.add(EnvironmentCacheStore, cache),
    );
  }),
);

const unavailable = (detail: string) =>
  new ConnectionBlockedError({ reason: "unsupported", detail });
const notSignedIn = () => Effect.die("This verifier is not signed in to T3 Connect.");

/**
 * Not signed in to T3 Connect, no SSH, always online, never backgrounded. The user is on screen
 * while `visible` says so, and touches the app whenever they come back.
 */
const platformLayer = (
  manager: PrimaryConnectionRegistration,
  bearer: string,
  visible: Queue.Queue<boolean>,
) =>
  Layer.mergeAll(
    memoryStorageLayer,
    Presence.layer({ visible: Stream.fromQueue(visible), inputs: Stream.never }),
    NodeSocket.layerWebSocketConstructor,
    Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
    Wakeups.layer({ changes: Stream.never }),
    Layer.succeed(
      PlatformConnectionSource,
      PlatformConnectionSource.of({ registrations: Stream.make([manager]) }),
    ),
    Layer.succeed(
      PrimaryEnvironmentAuth,
      PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeedSome(bearer) }),
    ),
    Layer.succeed(
      ClientPresentation,
      ClientPresentation.of({ metadata: CLIENT_METADATA, scopes: AuthStandardClientScopes }),
    ),
    Layer.succeed(
      CloudSession,
      CloudSession.of({
        identity: Effect.succeedNone,
        clerkToken: Effect.fail(
          new ConnectionBlockedError({
            reason: "authentication",
            detail: "Not signed in to T3 Connect.",
          }),
        ),
      }),
    ),
    Layer.succeed(RelayDeviceIdentity, RelayDeviceIdentity.of({ deviceId: Effect.succeedNone })),
    Layer.succeed(
      SshEnvironmentGateway,
      SshEnvironmentGateway.of({
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

const clientLayer = (
  manager: PrimaryConnectionRegistration,
  bearer: string,
  visible: Queue.Queue<boolean>,
) =>
  Connection.layerWithOptions({
    environmentThemes: true,
    usageLimitSources: true,
    usageLimitsCommand: true,
  }).pipe(Layer.provideMerge(platformLayer(manager, bearer, visible)));

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
  yield* Queue.offer(visible, true);
  let wokeWhileAway = false;
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
      const registry = yield* EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding;
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

      const config = yield* onManager("server.getConfig", request(WS_METHODS.serverGetConfig, {}));
      const instance = config.providers.find((provider) => provider.enabled);
      if (instance === undefined)
        return yield* new VerifyFailure({ message: "the manager has no enabled provider account" });
      const requestId = ProvisionRequestId.make(yield* crypto.randomUUIDv4);
      created.requestId = requestId;
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
        yield* registry.demand(boxId);
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

        if (options.awaySeconds > 0) {
          yield* Queue.offer(visible, false);
          yield* Console.log(`[${yield* elapsed}s] user leaves: the app is hidden`);
        }
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
        const timeout = Duration.minutes(options.timeoutMinutes);
        const came = yield* waitFor("box reconnected after pause", timeout, (entries) => {
          const after = entries.filter((entry) => entry.environment === "box" && entry.afterPause);
          return (
            after.some((entry) => entry.phase !== "connected") &&
            after.at(-1)?.phase === "connected"
          );
        }).pipe(
          Effect.as(true),
          Effect.catchTag("VerifyFailure", (failure) =>
            Effect.sync(() => ((error = failure.message), false)),
          ),
        );
        outcome = came ? "reconnected" : "not-reconnected";
      }).pipe(Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(manager, bearer, visible)));
  });

  /** Disposes the box on the manager, retrying while another lease operation holds it. */
  const dispose = Effect.fn("dispose")(function* (
    registry: EnvironmentRegistry["Service"],
    managerId: EnvironmentId,
  ) {
    if (created.requestId === null) return;
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
  const ok = outcome === "reconnected" || (options.dryRun && outcome === "connected-dry-run");
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
  },
  (flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* verify({
        origin: new URL(flags.origin).origin,
        pairingTokenFile: path.resolve(flags.pairingTokenFile),
        provider: flags.provider,
        timeoutMinutes: flags.timeoutMinutes,
        report: path.resolve(flags.report),
        dryRun: flags.dryRun,
        awaySeconds: flags.awaySeconds,
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
    Effect.provide(Layer.mergeAll(NodeServices.layer, remoteHttpClientLayer(globalThis.fetch))),
    NodeRuntime.runMain,
  );
}
