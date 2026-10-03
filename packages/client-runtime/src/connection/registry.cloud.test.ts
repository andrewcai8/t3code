import {
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  DiscoveredProvisionedEnvironment,
  type EnvironmentProvisionAttachInput,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionResumeInput,
  type EnvironmentProvisionResumeResult,
  type EnvironmentProvisionTouchInput,
  WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ProjectId,
  type ProvisionedChat,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type CatalogRegistration,
  PrimaryConnectionRegistration,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import { newChatRunTargets, provisionedBox } from "../cloud/provisioning.ts";
import { PairingRedemption } from "./boxPairing.ts";
import type { PairingConnectionInput } from "./onboarding.ts";
import {
  type EnvironmentConnectionPresentation,
  presentEnvironmentConnection,
} from "./presentation.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { UserPresence, makeUserPresence } from "./presence.ts";
import { followPlatformRegistrations } from "./platformRegistrations.ts";
import { v2ShellSnapshot, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay"),
  label: "Relay environment",
});

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-bearer"),
  label: "Bearer environment",
  connectionId: "bearer-connection",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: BEARER_TARGET.environmentId,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://bearer.example.test",
  wsBaseUrl: "wss://bearer.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});

/** A cloud box the host `TARGET` provisioned, saved as it is after pairing: `e2b.local`. */
const HOST_BOX = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-e2b-box"),
  label: "e2b.local",
  connectionId: "bearer:environment-e2b-box",
  box: { managerId: TARGET.environmentId },
});
const HOST_BOX_PROFILE = new BearerConnectionProfile({
  connectionId: HOST_BOX.connectionId,
  environmentId: HOST_BOX.environmentId,
  label: HOST_BOX.label,
  httpBaseUrl: "https://e2b-box.example.test",
  wsBaseUrl: "wss://e2b-box.example.test",
});

/** How the host lists `HOST_BOX`. */
const LISTED_HOST_BOX = {
  requestId: "11111111-1111-4111-8111-111111111111",
  leaseId: "lease-e2b-box",
  sandboxId: "sandbox-e2b-box",
  lifecycle: "active",
  environmentId: HOST_BOX.environmentId,
  provider: "e2b",
  label: "e2b.local",
  repository: null,
  threadId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-02T00:00:00.000Z",
} as unknown as DiscoveredProvisionedEnvironment;

const decodeListedBox = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment);

/** How the host `TARGET` lists a box: a claimed chat box, active, named for its repository. */
function listedBox(
  environmentId: EnvironmentId,
  overrides: {
    readonly lifecycle?: DiscoveredProvisionedEnvironment["lifecycle"];
    readonly label?: string;
    readonly chat?: ProvisionedChat;
  } = {},
): DiscoveredProvisionedEnvironment {
  return decodeListedBox({
    requestId: "22222222-2222-4222-8222-222222222222",
    leaseId: "22222222-2222-4222-8222-222222222222",
    sandboxId: `sandbox-${environmentId}`,
    lifecycle: overrides.lifecycle ?? "active",
    environmentId,
    provider: "e2b",
    label: overrides.label ?? "t3code · E2B",
    repository: "pingdotgg/t3code",
    projectDir: "/workspace/t3code",
    threadId: "thread-cloud-chat",
    ...(overrides.chat === undefined ? {} : { chat: overrides.chat }),
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-02T00:00:00.000Z",
  });
}

const CHAT_BOX_ID = EnvironmentId.make("environment-chat-box");
const CHAT_PROJECT: OrchestrationProjectShell = {
  id: ProjectId.make("project-cloud"),
  title: "t3code",
  workspaceRoot: "/workspace/t3code",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
// Decoded, as the host's listing is, so its defaulted fields match the listed copy.
const CHAT_THREAD = Schema.decodeUnknownSync(OrchestrationV2ThreadShell)({
  ...v2ThreadShell,
  id: ThreadId.make("thread-cloud-chat"),
  projectId: CHAT_PROJECT.id,
  title: "Fix the flaky test",
});
function chatAt(sequence: number): ProvisionedChat {
  return { sequence, project: CHAT_PROJECT, thread: CHAT_THREAD };
}
function seededShell(sequence: number): OrchestrationV2ShellSnapshot {
  return {
    ...v2ShellSnapshot,
    snapshotSequence: sequence,
    projects: [CHAT_PROJECT],
    threads: [CHAT_THREAD],
  };
}
const UNPAIRED_CHAT_BOX = new BearerConnectionTarget({
  environmentId: CHAT_BOX_ID,
  label: "t3code · E2B",
  connectionId: "bearer:environment-chat-box",
  box: { managerId: TARGET.environmentId },
});

const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "test",
  hostname: "test.example.test",
  username: "developer",
  port: 22,
};
const SSH_CONNECTION = new SshConnectionTarget({
  environmentId: EnvironmentId.make("environment-ssh"),
  label: "SSH environment",
  connectionId: "ssh-connection",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_CONNECTION.connectionId,
  environmentId: SSH_CONNECTION.environmentId,
  label: SSH_CONNECTION.label,
  target: SSH_TARGET,
});

const CACHED_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

interface SessionControl {
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (
  initialTargets: ReadonlyArray<ConnectionTarget>,
  initialProfiles: ReadonlyArray<ConnectionProfile> = [],
  initialCredentials: ReadonlyArray<readonly [string, ConnectionCredential]> = [],
  options?: {
    readonly prepareError?: ConnectionBlockedError;
    readonly prepare?: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    readonly resume?: (
      input: EnvironmentProvisionResumeInput,
    ) => Effect.Effect<EnvironmentProvisionResumeResult>;
    /** The boxes the host lists; none unless given. */
    readonly listProvisioned?: ReadonlyArray<DiscoveredProvisionedEnvironment>;
    /** The boxes the host lists at the time it is asked; overrides `listProvisioned`. */
    readonly lists?: Effect.Effect<ReadonlyArray<DiscoveredProvisionedEnvironment>>;
    /** The host's answer to an attach; by default it mints a pairing for the listed box. */
    readonly attach?: (
      input: EnvironmentProvisionAttachInput,
    ) => Effect.Effect<EnvironmentProvisionAttachResult>;
    readonly touch?: (input: EnvironmentProvisionTouchInput) => Effect.Effect<void>;
    readonly beforeSessionConnect?: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly beforeRegistrationRegister?: (
      registration: CatalogRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeRegistrationRemove?: (
      target: ConnectionTarget,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly initialDisabled?: ReadonlyArray<EnvironmentId>;
    /** Runs as the cache is read, holding whoever reads it. */
    readonly beforeLoadShell?: (environmentId: EnvironmentId) => Effect.Effect<void>;
  },
) {
  const storedTargets = yield* Ref.make(
    new Map(initialTargets.map((target) => [target.environmentId, target])),
  );
  const shellCache = yield* Ref.make(new Map([[TARGET.environmentId, CACHED_SNAPSHOT]]));
  const cacheClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const ownedDataClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const sessions = yield* Ref.make<ReadonlyArray<SessionControl>>([]);
  const preparations = yield* Ref.make(0);
  const dialed = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const attaches = yield* Ref.make<ReadonlyArray<string>>([]);
  const redemptions = yield* Ref.make<ReadonlyArray<PairingConnectionInput>>([]);
  const registrationWrites = yield* Ref.make(0);
  const listed = options?.lists ?? Effect.succeed(options?.listProvisioned ?? []);
  const releasedSessions = yield* Ref.make(0);
  const storedProfiles = yield* Ref.make(
    new Map(initialProfiles.map((profile) => [profile.connectionId, profile])),
  );
  const profileReadCount = yield* Ref.make(0);
  const storedCredentials = yield* Ref.make(new Map(initialCredentials));
  const storedRemoteTokens = yield* Ref.make(
    new Map([
      [
        SSH_CONNECTION.environmentId,
        new TokenStore.RemoteDpopAccessToken({
          environmentId: SSH_CONNECTION.environmentId,
          label: SSH_CONNECTION.label,
          endpoint: {
            httpBaseUrl: "https://ssh.example.test",
            wsBaseUrl: "wss://ssh.example.test",
            providerKind: "cloudflare_tunnel",
          },
          accessToken: "cached-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          dpopThumbprint: "thumbprint",
        }),
      ],
    ]),
  );
  const disconnectedSshTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);

  const storedDisabled = yield* Ref.make<ReadonlySet<EnvironmentId>>(
    new Set(options?.initialDisabled ?? []),
  );
  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Ref.get(storedTargets).pipe(Effect.map((targets) => [...targets.values()])),
    listDisabled: Ref.get(storedDisabled).pipe(Effect.map((ids) => [...ids])),
  });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* Ref.update(registrationWrites, (count) => count + 1);
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.set(registration.target.environmentId, registration.target);
          return next;
        });
        switch (registration._tag) {
          case "RelayConnectionRegistration":
            return;
          case "BearerConnectionRegistration":
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.set(registration.profile.connectionId, registration.profile);
              return next;
            });
            yield* Ref.update(storedCredentials, (current) => {
              const next = new Map(current);
              next.set(registration.target.connectionId, registration.credential);
              return next;
            });
            return;
          case "SshConnectionRegistration":
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.set(registration.profile.connectionId, registration.profile);
              return next;
            });
        }
      }),
    remove: (target) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRemove?.(target) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.delete(target.environmentId);
          return next;
        });
        if (target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget") {
          yield* Ref.update(storedProfiles, (current) => {
            const next = new Map(current);
            next.delete(target.connectionId);
            return next;
          });
          yield* Ref.update(storedCredentials, (current) => {
            const next = new Map(current);
            next.delete(target.connectionId);
            return next;
          });
        }
        yield* Ref.update(storedRemoteTokens, (current) => {
          const next = new Map(current);
          next.delete(target.environmentId);
          return next;
        });
      }),
    setEnabled: (environmentId, enabled) =>
      Ref.update(storedDisabled, (current) => {
        const next = new Set(current);
        if (enabled) {
          next.delete(environmentId);
        } else {
          next.add(environmentId);
        }
        return next;
      }),
  });
  const cacheStore = Persistence.EnvironmentCacheStore.of({
    loadShell: (environmentId) =>
      (options?.beforeLoadShell?.(environmentId) ?? Effect.void).pipe(
        Effect.andThen(Ref.get(shellCache)),
        Effect.map((cache) => Option.fromUndefinedOr(cache.get(environmentId))),
      ),
    saveShell: (environmentId, snapshot) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.set(environmentId, snapshot);
        return next;
      }),
    loadThread: (_environmentId, _threadId) => Effect.succeedNone,
    saveThread: (_environmentId, _thread) => Effect.void,
    removeThread: (_environmentId, _threadId) => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: (environmentId) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(cacheClears, (environmentIds) => [...environmentIds, environmentId]),
        ),
      ),
  });
  const ownedDataCleanup = Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Ref.update(ownedDataClears, (environmentIds) => [...environmentIds, environmentId]),
  });
  const networkStatus = yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online");
  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) =>
      Ref.update(profileReadCount, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(storedProfiles)),
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (profile) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.set(profile.connectionId, profile);
        return next;
      }),
    remove: (connectionId) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) =>
      Ref.get(storedCredentials).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (connectionId, credential) =>
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.set(connectionId, credential);
        return next;
      }),
    remove: (connectionId) =>
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(storedRemoteTokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      ),
    put: (token) =>
      Ref.update(storedRemoteTokens, (current) => {
        const next = new Map(current);
        next.set(token.environmentId, token);
        return next;
      }),
    remove: (environmentId) =>
      Ref.update(storedRemoteTokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const sshGateway = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die(new Error("SSH provisioning is not used.")),
    prepare: () => Effect.die(new Error("SSH preparation is not used.")),
    disconnect: (target) => Ref.update(disconnectedSshTargets, (current) => [...current, target]),
  });
  const driver = yield* ConnectionDriver.make.pipe(
    Effect.provideService(ConnectionResolver.ConnectionResolver, {
      prepare: (entry) =>
        Effect.gen(function* () {
          yield* Ref.update(preparations, (count) => count + 1);
          yield* Ref.update(dialed, (current) => [...current, entry.target.environmentId]);
          if (options?.prepareError) return yield* options.prepareError;
          yield* options?.prepare?.(entry.target.environmentId) ?? Effect.void;
          return {
            ...PREPARED,
            environmentId: entry.target.environmentId,
            label: entry.target.label,
            target: entry.target,
          };
        }),
    }),
    Effect.provideService(RpcSession.RpcSessionFactory, {
      connect: (prepared) =>
        Effect.gen(function* () {
          yield* options?.beforeSessionConnect?.(prepared.environmentId) ?? Effect.void;
          const closed = yield* Deferred.make<never, ConnectionTransientError>();
          yield* Ref.update(sessions, (current) => [...current, { closed }]);
          return yield* Effect.acquireRelease(
            Effect.succeed({
              client: {
                [WS_METHODS.environmentControlResume]: (input: EnvironmentProvisionResumeInput) =>
                  options?.resume?.(input) ??
                  Effect.die(new Error("Resume is not used by this test.")),
                [WS_METHODS.environmentControlListProvisioned]: () => listed,
                [WS_METHODS.environmentControlAttach]: (input: EnvironmentProvisionAttachInput) =>
                  Ref.update(attaches, (current) => [...current, input.requestId]).pipe(
                    Effect.andThen(
                      options?.attach?.(input) ??
                        listed.pipe(
                          Effect.map((rows): EnvironmentProvisionAttachResult => {
                            const row = rows.find(({ requestId }) => requestId === input.requestId);
                            return row === undefined
                              ? { kind: "refused", message: "The host has no such request." }
                              : {
                                  kind: "attached",
                                  environmentId: row.environmentId,
                                  pairingUrl: `https://${row.environmentId}.example.test/pair#token=minted`,
                                };
                          }),
                        ),
                    ),
                  ),
                [WS_METHODS.environmentControlTouch]: (input: EnvironmentProvisionTouchInput) =>
                  (options?.touch?.(input) ?? Effect.void).pipe(
                    Effect.as({ kind: "touched" as const }),
                  ),
              } as unknown as RpcSession.RpcSession["client"],
              initialConfig: Effect.die(new Error("Config is not used by registry tests.")),
              subscribeServerConfig: () =>
                Stream.die(new Error("Config is not used by registry tests.")),
              ready: Effect.void,
              probe: Effect.void,
              closed: Deferred.await(closed),
            } satisfies RpcSession.RpcSession),
            () => Ref.update(releasedSessions, (count) => count + 1),
          );
        }),
    }),
  );

  const cacheLayer = Layer.succeed(Persistence.EnvironmentCacheStore, cacheStore);
  const layer = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Persistence.ConnectionTargetStore, targetStore),
        Layer.succeed(Persistence.ConnectionRegistrationStore, registrationStore),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, sshGateway),
        Layer.succeed(Connectivity.Connectivity, connectivity),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
        ),
        Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
        Layer.succeed(
          PairingRedemption,
          PairingRedemption.of({
            redeem: (input) =>
              Ref.modify(
                redemptions,
                (current) => [current.length + 1, [...current, input]] as const,
              ).pipe(
                Effect.map((count) => {
                  const environmentId =
                    input.expectedEnvironmentId ?? EnvironmentId.make("unexpected-box");
                  const connectionId = `bearer:${environmentId}`;
                  return new BearerConnectionRegistration({
                    target: new BearerConnectionTarget({
                      environmentId,
                      label: "e2b.local",
                      connectionId,
                      ...(input.box === undefined ? {} : { box: input.box }),
                    }),
                    profile: new BearerConnectionProfile({
                      connectionId,
                      environmentId,
                      label: "e2b.local",
                      httpBaseUrl: `https://${environmentId}.example.test`,
                      wsBaseUrl: `wss://${environmentId}.example.test`,
                    }),
                    credential: new BearerConnectionCredential({ token: `box-token-${count}` }),
                  });
                }),
              ),
          }),
        ),
        cacheLayer,
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, ownedDataCleanup),
      ),
    ),
  );

  return {
    layer,
    dialed,
    attaches,
    redemptions,
    registrationWrites,
    storedTargets,
    shellCache,
    cacheClears,
    ownedDataClears,
    sessions,
    preparations,
    releasedSessions,
    storedProfiles,
    profileReadCount,
    storedCredentials,
    storedRemoteTokens,
    storedDisabled,
    disconnectedSshTargets,
    networkStatus,
  };
});

function awaitConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .stateChanges(environmentId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

const BOX_NOT_SERVING = new ConnectionTransientError({
  reason: "not-serving",
  detail:
    "Remote environment endpoint https://e2b-box.example.test/ returned undeclared status 502.",
});

const HOST_UNREACHABLE = new ConnectionTransientError({
  reason: "network",
  detail: "https://environment.example.test/ could not be reached.",
});

/**
 * The host `TARGET` and its box `HOST_BOX`. The box's dial says not serving until a resume the
 * host answers `resumed` wakes it. The host answers resumes with `answers` in order, repeating the
 * last; `"never"` never answers, `"cut-off"` ends the call the way the RPC client ends a call
 * whose session is closed under it: interrupted, and `"defect"` ends it as a crashed handler does. The host's dial fails while `hostUp` is false.
 */
const makeBoxWakeHarness = Effect.fn("TestEnvironmentRegistry.makeBoxWakeHarness")(function* (
  answers: ReadonlyArray<EnvironmentProvisionResumeResult | "never" | "cut-off" | "defect">,
  options?: {
    readonly serving?: boolean;
    readonly hostUp?: boolean;
    readonly listProvisioned?: ReadonlyArray<DiscoveredProvisionedEnvironment>;
    /** Touches the host cuts off, in order, before it answers the rest. */
    readonly cutOffTouches?: number;
    /** Holds the host's session until it is opened. */
    readonly hostGate?: Deferred.Deferred<void>;
  },
) {
  const touches = yield* Ref.make<ReadonlyArray<EnvironmentProvisionTouchInput>>([]);
  const serving = yield* Ref.make(options?.serving ?? false);
  const hostUp = yield* Ref.make(options?.hostUp ?? true);
  const resumes = yield* Ref.make<ReadonlyArray<EnvironmentProvisionResumeInput>>([]);
  const harness = yield* makeHarness(
    [TARGET, HOST_BOX],
    [HOST_BOX_PROFILE],
    [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
    {
      prepare: (environmentId) =>
        environmentId !== HOST_BOX.environmentId
          ? Ref.get(hostUp).pipe(
              Effect.flatMap((up) => (up ? Effect.void : Effect.fail(HOST_UNREACHABLE))),
            )
          : Ref.get(serving).pipe(
              Effect.flatMap((isServing) =>
                isServing ? Effect.void : Effect.fail(BOX_NOT_SERVING),
              ),
            ),
      resume: (input) =>
        Ref.modify(resumes, (current) => [current.length, [...current, input]] as const).pipe(
          Effect.flatMap((index): Effect.Effect<EnvironmentProvisionResumeResult> => {
            const answer = answers[Math.min(index, answers.length - 1)] ?? "never";
            if (answer === "never") return Effect.never;
            if (answer === "cut-off") return Effect.interrupt;
            if (answer === "defect")
              return Effect.die(new Error("The host's resume handler crashed."));
            return answer.kind === "resumed"
              ? Ref.set(serving, true).pipe(Effect.as(answer))
              : Effect.succeed(answer);
          }),
        ),
      ...(options?.listProvisioned ? { listProvisioned: options.listProvisioned } : {}),
      ...(options?.hostGate
        ? {
            beforeSessionConnect: (environmentId: EnvironmentId) =>
              environmentId === TARGET.environmentId
                ? Deferred.await(options.hostGate!)
                : Effect.void,
          }
        : {}),
      touch: (input) =>
        Ref.modify(touches, (current) => [current.length, [...current, input]] as const).pipe(
          Effect.flatMap((index) =>
            index < (options?.cutOffTouches ?? 0) ? Effect.interrupt : Effect.void,
          ),
        ),
    },
  );
  return { harness, serving, hostUp, resumes, touches };
});

const recordPhases = Effect.fn("TestEnvironmentRegistry.recordPhases")(function* (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
) {
  const phases = yield* Ref.make<ReadonlyArray<SupervisorConnectionState["phase"]>>([]);
  const following = yield* Deferred.make<void>();
  yield* registry.stateChanges(environmentId).pipe(
    Stream.runForEach((state) =>
      Ref.update(phases, (current) => [...current, state.phase]).pipe(
        Effect.andThen(Deferred.succeed(following, undefined)),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(following);
  return phases;
});

describe("EnvironmentRegistry", () => {
  it.effect("persists a missing workspace without reconnecting or deleting saved data", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Ref.update(harness.shellCache, (cache) =>
        new Map(cache).set(BEARER_TARGET.environmentId, CACHED_SNAPSHOT),
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        yield* registry.markWorkspaceMissing(BEARER_TARGET.environmentId);
        const missing = yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "blocked",
        );
        expect(missing.lastFailure).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "workspace-missing",
        });
        expect(missing.retryAt).toBeNull();
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);

        yield* registry.markWorkspaceMissing(BEARER_TARGET.environmentId);
        yield* registry.retryNow(BEARER_TARGET.environmentId);
        yield* TestClock.adjust("24 hours");
        expect(yield* Ref.get(harness.preparations)).toBe(1);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect((yield* Ref.get(harness.storedTargets)).get(BEARER_TARGET.environmentId)).toEqual(
          new BearerConnectionTarget({ ...BEARER_TARGET, workspaceStatus: "missing" }),
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);

      yield* Effect.gen(function* () {
        const reloaded = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* reloaded.start;
        const missing = yield* awaitConnectionState(
          reloaded,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "blocked",
        );
        expect(missing.lastFailure?.reason).toBe("workspace-missing");
        expect(yield* Ref.get(harness.preparations)).toBe(1);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect((yield* Ref.get(harness.shellCache)).get(BEARER_TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );
        expect((yield* Ref.get(harness.storedProfiles)).get(BEARER_TARGET.connectionId)).toEqual(
          BEARER_PROFILE,
        );
        expect((yield* Ref.get(harness.storedCredentials)).get(BEARER_TARGET.connectionId)).toEqual(
          BEARER_CREDENTIAL,
        );
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);

        yield* reloaded.register(
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        );
        yield* awaitConnectionState(
          reloaded,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* Ref.get(harness.preparations)).toBe(2);
        expect((yield* Ref.get(harness.storedTargets)).get(BEARER_TARGET.environmentId)).toEqual(
          BEARER_TARGET,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a platform poll that reports the same environments does no work and records no spans",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([]);
        const spans: Array<string> = [];
        const tracer = Tracer.make({
          span(options) {
            spans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          // Each poll builds its registrations afresh, as the web's does once a bearer is refreshed.
          const polls = Stream.tick("3 seconds").pipe(
            Stream.map(() => [new PrimaryConnectionRegistration({ target: TARGET })]),
          );
          yield* followPlatformRegistrations(registry, polls).pipe(
            Effect.withTracer(tracer),
            Effect.forkScoped,
          );
          yield* SubscriptionRef.changes(registry.entries).pipe(
            Stream.filter((entries) => entries.has(TARGET.environmentId)),
            Stream.runHead,
          );
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          spans.length = 0;

          yield* TestClock.adjust("1 minute");

          expect(spans).toEqual([]);
          expect((yield* registry.state(TARGET.environmentId)).phase).toBe("connected");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not mark platform or non-bearer environments as missing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET, SSH_CONNECTION], [SSH_PROFILE]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.reconcilePlatform([
          new PrimaryConnectionRegistration({ target: TARGET }),
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        ]);
        for (const target of [TARGET, BEARER_TARGET, RELAY_TARGET, SSH_CONNECTION]) {
          yield* registry.markWorkspaceMissing(target.environmentId);
          expect(
            (yield* SubscriptionRef.get(registry.entries)).get(target.environmentId)?.target,
          ).toEqual(target);
        }
        expect(yield* Ref.get(harness.storedTargets)).toEqual(
          new Map<EnvironmentId, ConnectionTarget>([
            [RELAY_TARGET.environmentId, RELAY_TARGET],
            [SSH_CONNECTION.environmentId, SSH_CONNECTION],
          ]),
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps the prior registration when persisting a missing workspace fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          beforeRegistrationRegister: () =>
            Effect.fail(
              new Persistence.ConnectionPersistenceError({
                operation: "register-connection",
                message: "Storage is unavailable.",
              }),
            ),
        },
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const failure = yield* registry
          .markWorkspaceMissing(BEARER_TARGET.environmentId)
          .pipe(Effect.flip);
        expect(failure._tag).toBe("ConnectionPersistenceError");
        expect((yield* registry.state(BEARER_TARGET.environmentId)).phase).toBe("connected");
        expect((yield* Ref.get(harness.storedTargets)).get(BEARER_TARGET.environmentId)).toEqual(
          BEARER_TARGET,
        );
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a saved box connects only while its chat demands it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [TARGET, HOST_BOX],
        [HOST_BOX_PROFILE],
        [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* TestClock.adjust("1 hour");
        expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("available");
        expect(yield* Ref.get(harness.preparations)).toBe(1);

        const chat = yield* Scope.make();
        const secondView = yield* Scope.make();
        yield* registry.demand(HOST_BOX.environmentId).pipe(Scope.provide(chat));
        yield* registry.demand(HOST_BOX.environmentId).pipe(Scope.provide(secondView));
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* SubscriptionRef.get(registry.demanded)).toEqual(
          new Set([HOST_BOX.environmentId]),
        );

        yield* Scope.close(chat, Exit.void);
        expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");

        yield* Scope.close(secondView, Exit.void);
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "available",
        );
        expect(yield* SubscriptionRef.get(registry.demanded)).toEqual(new Set());
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);
        yield* TestClock.adjust("1 hour");
        expect(yield* Ref.get(harness.preparations)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a demanded box whose dial says not serving is woken through its host, woken again after a refused wake, and connects",
    () =>
      Effect.gen(function* () {
        const { harness, resumes } = yield* makeBoxWakeHarness([
          { kind: "refused", reason: "unknown", message: "Namespace could not start the Mac." },
          { kind: "resumed" },
        ]);

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          const phases = yield* recordPhases(registry, HOST_BOX.environmentId);

          yield* registry.demand(HOST_BOX.environmentId);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "backoff",
          );
          yield* TestClock.adjust("1 minute");
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "connected",
          );

          expect(yield* Ref.get(resumes)).toEqual([
            { environmentId: HOST_BOX.environmentId },
            { environmentId: HOST_BOX.environmentId },
          ]);
          expect(yield* Ref.get(phases)).toContain("waking");
          expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a connected box whose session drops and whose dial then says not serving is woken without a click",
    () =>
      Effect.gen(function* () {
        const { harness, serving, resumes } = yield* makeBoxWakeHarness([{ kind: "resumed" }], {
          serving: true,
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* registry.demand(HOST_BOX.environmentId);
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "connected",
          );
          const boxSession = (yield* Ref.get(harness.sessions)).at(-1);

          yield* Ref.set(serving, false);
          yield* Deferred.fail(
            boxSession!.closed,
            new ConnectionTransientError({ reason: "transport", detail: "The box paused." }),
          );
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "backoff",
          );
          yield* TestClock.adjust("1 minute");
          const settled = yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) =>
              state.phase === "connected" ||
              (state.phase === "backoff" && state.lastFailure?.reason === "not-serving"),
          );

          expect(settled.phase).toBe("connected");
          expect(yield* Ref.get(resumes)).toEqual([{ environmentId: HOST_BOX.environmentId }]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closing the chat (dropping demand) mid-wake returns the box to available", () =>
    Effect.gen(function* () {
      const { harness, resumes } = yield* makeBoxWakeHarness(["never"]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        const chat = yield* Scope.make();
        yield* registry.demand(HOST_BOX.environmentId).pipe(Scope.provide(chat));
        const firstAfterDial = yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "waking" || state.phase === "backoff",
        );
        expect(firstAfterDial.phase).toBe("waking");

        yield* Scope.close(chat, Exit.void);
        const closed = yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "available",
        );
        yield* TestClock.adjust("1 hour");

        expect(closed.lastFailure).toBeNull();
        expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("available");
        expect(yield* Ref.get(resumes)).toEqual([{ environmentId: HOST_BOX.environmentId }]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a refused-missing wake marks the workspace missing", () =>
    Effect.gen(function* () {
      const { harness, resumes } = yield* makeBoxWakeHarness([
        { kind: "refused", reason: "missing", message: "The sandbox was not found" },
      ]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* registry.demand(HOST_BOX.environmentId);

        const blocked = yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "blocked",
        );
        yield* TestClock.adjust("1 hour");

        expect(blocked.lastFailure?.reason).toBe("workspace-missing");
        expect((yield* Ref.get(harness.storedTargets)).get(HOST_BOX.environmentId)).toEqual(
          new BearerConnectionTarget({ ...HOST_BOX, workspaceStatus: "missing" }),
        );
        expect(yield* Ref.get(resumes)).toEqual([{ environmentId: HOST_BOX.environmentId }]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a box that keeps saying it is not serving is woken at a widening interval", () =>
    Effect.gen(function* () {
      const { harness, resumes } = yield* makeBoxWakeHarness([
        { kind: "refused", reason: "unknown", message: "Namespace could not start the Mac." },
      ]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* registry.demand(HOST_BOX.environmentId);
        // Resumes the host has been asked for once the box settles into a backoff past `elapsed`.
        const resumesAt = Effect.fn("resumesAt")(function* (elapsed: Duration.Input) {
          const now = Duration.toMillis(Duration.fromInputUnsafe(elapsed));
          yield* TestClock.setTime(now);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "backoff" && (state.retryAt ?? 0) > now,
          );
          return (yield* Ref.get(resumes)).length;
        });

        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "backoff",
        );
        expect(yield* resumesAt("20 seconds")).toBe(1);
        expect(yield* resumesAt("45 seconds")).toBe(2);
        expect(yield* resumesAt("85 seconds")).toBe(2);
        expect(yield* resumesAt("110 seconds")).toBe(3);
        expect(yield* resumesAt("200 seconds")).toBe(3);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a box whose wake is cut off by its host's session closing wakes again and connects, instead of staying waking",
    () =>
      Effect.gen(function* () {
        const { harness, resumes } = yield* makeBoxWakeHarness(["cut-off", { kind: "resumed" }]);

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* registry.demand(HOST_BOX.environmentId);
          yield* TestClock.adjust("5 seconds");

          expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
          expect(yield* Ref.get(resumes)).toEqual([
            { environmentId: HOST_BOX.environmentId },
            { environmentId: HOST_BOX.environmentId },
          ]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a box whose wake ends in a defect is not left waking, and wakes again", () =>
    Effect.gen(function* () {
      const { harness, resumes } = yield* makeBoxWakeHarness(["defect", { kind: "resumed" }]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* registry.demand(HOST_BOX.environmentId);
        yield* TestClock.adjust("5 seconds");

        expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
        expect(yield* Ref.get(resumes)).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "retrying a box while its host has not answered the wake dials and wakes it again",
    () =>
      Effect.gen(function* () {
        const { harness, resumes } = yield* makeBoxWakeHarness(["never", { kind: "resumed" }]);

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* registry.demand(HOST_BOX.environmentId);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "waking",
          );

          yield* registry.retryNow(HOST_BOX.environmentId);
          yield* TestClock.adjust("1 second");

          expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
          expect(yield* Ref.get(resumes)).toHaveLength(2);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "reopening a paused box's chat wakes it at once, however often it was woken before",
    () =>
      Effect.gen(function* () {
        const { harness, resumes } = yield* makeBoxWakeHarness([
          { kind: "refused", reason: "unknown", message: "Namespace could not start the Mac." },
        ]);

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          const chat = yield* Scope.make();
          yield* registry.demand(HOST_BOX.environmentId).pipe(Scope.provide(chat));
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "backoff",
          );
          yield* TestClock.setTime(45_000);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "backoff" && (state.retryAt ?? 0) > 45_000,
          );
          expect(yield* Ref.get(resumes)).toHaveLength(2);
          yield* Scope.close(chat, Exit.void);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "available",
          );

          yield* registry.demand(HOST_BOX.environmentId);
          yield* TestClock.adjust("1 second");

          expect(yield* Ref.get(resumes)).toHaveLength(3);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a box whose host is down does not claim to be waking, and is woken on its next dial once its host is back",
    () =>
      Effect.gen(function* () {
        const { harness, hostUp, resumes } = yield* makeBoxWakeHarness([{ kind: "resumed" }], {
          hostUp: false,
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const phases = yield* recordPhases(registry, HOST_BOX.environmentId);
          yield* registry.start;
          yield* registry.demand(HOST_BOX.environmentId);
          yield* TestClock.adjust("3 minutes");
          expect(yield* Ref.get(phases)).not.toContain("waking");
          expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("backoff");

          yield* Ref.set(hostUp, true);
          yield* TestClock.adjust("32 seconds");

          expect(yield* Ref.get(resumes)).toEqual([{ environmentId: HOST_BOX.environmentId }]);
          expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a box opened while its host is still connecting is woken as soon as the host connects",
    () =>
      Effect.gen(function* () {
        const hostGate = yield* Deferred.make<void>();
        const { harness, resumes } = yield* makeBoxWakeHarness([{ kind: "resumed" }], { hostGate });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* registry.demand(HOST_BOX.environmentId);
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "connecting",
          );

          yield* Deferred.succeed(hostGate, undefined);
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "connected" || state.phase === "backoff",
          );

          expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
          expect(yield* Ref.get(resumes)).toEqual([{ environmentId: HOST_BOX.environmentId }]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a box's lease is still renewed after one renewal is cut off by its host's session",
    () =>
      Effect.gen(function* () {
        const { harness, touches } = yield* makeBoxWakeHarness([{ kind: "resumed" }], {
          serving: true,
          listProvisioned: [LISTED_HOST_BOX],
          cutOffTouches: 1,
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* registry.demand(HOST_BOX.environmentId);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "connected",
          );
          yield* TestClock.adjust("1 second");
          expect(yield* Ref.get(touches)).toHaveLength(1);

          yield* TestClock.adjust("4 minutes");
          expect(yield* Ref.get(touches)).toHaveLength(2);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an environment that is not a box is never woken, whatever its dial says", () =>
    Effect.gen(function* () {
      const resumes = yield* Ref.make<ReadonlyArray<EnvironmentProvisionResumeInput>>([]);
      const harness = yield* makeHarness(
        [TARGET, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          prepare: (environmentId) =>
            environmentId === BEARER_TARGET.environmentId
              ? Effect.fail(BOX_NOT_SERVING)
              : Effect.void,
          resume: (input) =>
            Ref.update(resumes, (current) => [...current, input]).pipe(
              Effect.as({ kind: "resumed" as const }),
            ),
        },
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const phases = yield* recordPhases(registry, BEARER_TARGET.environmentId);
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* TestClock.adjust("2 minutes");
        const failed = yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "backoff",
        );

        expect(failed.lastFailure?.reason).toBe("not-serving");
        expect(yield* Ref.get(phases)).not.toContain("waking");
        expect(yield* Ref.get(resumes)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a connected box keeps its lease alive through its host until its chat closes", () =>
    Effect.gen(function* () {
      const listed = LISTED_HOST_BOX;
      const { harness, touches } = yield* makeBoxWakeHarness([{ kind: "resumed" }], {
        serving: true,
        listProvisioned: [listed],
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        const chat = yield* Scope.make();
        yield* registry.demand(HOST_BOX.environmentId).pipe(Scope.provide(chat));
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "connected",
        );
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(touches)).toEqual([{ leaseId: "lease-e2b-box" }]);

        yield* TestClock.adjust("4 minutes");
        expect(yield* Ref.get(touches)).toEqual([
          { leaseId: "lease-e2b-box" },
          { leaseId: "lease-e2b-box" },
        ]);

        yield* Scope.close(chat, Exit.void);
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "available",
        );
        yield* TestClock.adjust("1 hour");
        expect(yield* Ref.get(touches)).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a box's lease is renewed only while its user is here: not while the app is hidden or untouched for an hour",
    () =>
      Effect.gen(function* () {
        const visible = yield* Queue.unbounded<boolean>();
        const inputs = yield* Queue.unbounded<void>();
        const presence = yield* makeUserPresence({
          visible: Stream.fromQueue(visible),
          inputs: Stream.fromQueue(inputs),
        });
        yield* Queue.offer(visible, true);
        const { harness, touches } = yield* makeBoxWakeHarness([{ kind: "resumed" }], {
          serving: true,
          listProvisioned: [LISTED_HOST_BOX],
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* registry.demand(HOST_BOX.environmentId);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (state) => state.phase === "connected",
          );
          const touchCount = Effect.fn("touchCount")(function* (elapsed: Duration.Input) {
            yield* TestClock.adjust(elapsed);
            return (yield* Ref.get(touches)).length;
          });
          expect(yield* touchCount("1 second")).toBe(1);

          yield* Queue.offer(visible, false);
          expect(yield* touchCount("20 minutes")).toBe(1);
          yield* Queue.offer(visible, true);
          expect(yield* touchCount("1 second")).toBe(2);

          // Input a minute after coming back keeps the user here until an hour after it, past
          // the beat at 60 minutes and short of the one at 64.
          yield* TestClock.adjust("1 minute");
          yield* Queue.offer(inputs, undefined);
          expect(yield* touchCount("61 minutes")).toBe(17);
          expect(yield* touchCount("1 hour")).toBe(17);
          yield* Queue.offer(inputs, undefined);
          expect(yield* touchCount("1 second")).toBe(18);
        }).pipe(
          Effect.provide(harness.layer),
          Effect.provideService(UserPresence, presence),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("a box paused while its user is away wakes only once they come back", () =>
    Effect.gen(function* () {
      const visible = yield* Queue.unbounded<boolean>();
      const presence = yield* makeUserPresence({
        visible: Stream.fromQueue(visible),
        inputs: Stream.never,
      });
      yield* Queue.offer(visible, false);
      const { harness, resumes } = yield* makeBoxWakeHarness([{ kind: "resumed" }]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const phases = yield* recordPhases(registry, HOST_BOX.environmentId);
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* registry.demand(HOST_BOX.environmentId);
        yield* TestClock.adjust("10 minutes");
        const away = yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "backoff",
        );
        expect(away.lastFailure?.reason).toBe("not-serving");
        expect(yield* Ref.get(phases)).not.toContain("waking");
        expect(yield* Ref.get(resumes)).toEqual([]);

        yield* Queue.offer(visible, true);
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* Ref.get(resumes)).toEqual([{ environmentId: HOST_BOX.environmentId }]);
      }).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(UserPresence, presence),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("a legacy saved box stops connecting in the background once it is marked", () =>
    Effect.gen(function* () {
      const legacyBox = new BearerConnectionTarget({
        environmentId: HOST_BOX.environmentId,
        label: HOST_BOX.label,
        connectionId: HOST_BOX.connectionId,
      });
      const harness = yield* makeHarness(
        [TARGET, legacyBox, SSH_CONNECTION],
        [HOST_BOX_PROFILE, SSH_PROFILE],
        [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Ref.update(harness.shellCache, (cache) =>
        new Map(cache).set(HOST_BOX.environmentId, CACHED_SNAPSHOT),
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          legacyBox.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.markBoxes([
          { environmentId: legacyBox.environmentId, managerId: TARGET.environmentId },
          { environmentId: SSH_CONNECTION.environmentId, managerId: TARGET.environmentId },
          {
            environmentId: EnvironmentId.make("environment-not-saved"),
            managerId: TARGET.environmentId,
          },
        ]);
        yield* awaitConnectionState(
          registry,
          legacyBox.environmentId,
          (state) => state.phase === "available",
        );
        const stored = yield* Ref.get(harness.storedTargets);
        expect(stored.get(legacyBox.environmentId)).toEqual(HOST_BOX);
        expect(stored.get(SSH_CONNECTION.environmentId)).toEqual(SSH_CONNECTION);
        expect(stored.has(EnvironmentId.make("environment-not-saved"))).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);

      const preparationsBeforeReload = yield* Ref.get(harness.preparations);
      yield* Effect.gen(function* () {
        const reloaded = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* reloaded.start;
        yield* TestClock.adjust("1 hour");
        expect((yield* reloaded.state(HOST_BOX.environmentId)).phase).toBe("available");
        // Only the host and the SSH machine dialed; the box's history and credential stay.
        expect(yield* Ref.get(harness.preparations)).toBe(preparationsBeforeReload + 2);
        expect((yield* Ref.get(harness.shellCache)).get(HOST_BOX.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );
        expect((yield* Ref.get(harness.storedCredentials)).get(HOST_BOX.connectionId)).toEqual(
          BEARER_CREDENTIAL,
        );

        yield* reloaded.demand(HOST_BOX.environmentId);
        yield* awaitConnectionState(
          reloaded,
          HOST_BOX.environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("never marks a host as a box, and a wrong mark can be undone", () =>
    Effect.gen(function* () {
      const server = new BearerConnectionTarget({
        environmentId: EnvironmentId.make("andrew-megpt-host"),
        label: "andrew.megpt.app",
        connectionId: "bearer:andrew-megpt-host",
      });
      const serverProfile = new BearerConnectionProfile({
        connectionId: server.connectionId,
        environmentId: server.environmentId,
        label: server.label,
        httpBaseUrl: "https://andrew.megpt.app",
        wsBaseUrl: "wss://andrew.megpt.app",
      });
      const harness = yield* makeHarness(
        [server, HOST_BOX],
        [serverProfile, HOST_BOX_PROFILE],
        [
          [server.connectionId, BEARER_CREDENTIAL],
          [HOST_BOX.connectionId, BEARER_CREDENTIAL],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, server.environmentId, (s) => s.phase === "connected");
        // The server provisions boxes, so it is a manager, whatever a lease or list says.
        yield* registry.markBoxes([
          { environmentId: server.environmentId, managerId: EnvironmentId.make("other-host") },
          { environmentId: EnvironmentId.make("new-box"), managerId: server.environmentId },
        ]);
        yield* registry.markBoxes([
          { environmentId: server.environmentId, managerId: server.environmentId },
        ]);
        expect((yield* Ref.get(harness.storedTargets)).get(server.environmentId)).toEqual(server);
        expect((yield* registry.state(server.environmentId)).phase).toBe("connected");

        // A box marked by mistake goes back to being an ordinary environment.
        yield* registry.unmarkBox(HOST_BOX.environmentId);
        const unmarked = new BearerConnectionTarget({
          environmentId: HOST_BOX.environmentId,
          label: HOST_BOX.label,
          connectionId: HOST_BOX.connectionId,
        });
        expect((yield* Ref.get(harness.storedTargets)).get(HOST_BOX.environmentId)).toEqual(
          unmarked,
        );
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("pairing a box again keeps it a box", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [HOST_BOX],
        [HOST_BOX_PROFILE],
        [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              environmentId: HOST_BOX.environmentId,
              label: HOST_BOX.label,
              connectionId: HOST_BOX.connectionId,
            }),
            profile: HOST_BOX_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        );
        expect((yield* Ref.get(harness.storedTargets)).get(HOST_BOX.environmentId)).toEqual(
          HOST_BOX,
        );
        yield* TestClock.adjust("1 hour");
        expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("available");
        expect(yield* Ref.get(harness.preparations)).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops dialing and offering the saved boxes a host reports gone", () =>
    Effect.gen(function* () {
      const pausedBox = new BearerConnectionTarget({
        environmentId: EnvironmentId.make("environment-paused-box"),
        label: "Paused box",
        connectionId: "paused-box-connection",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET, pausedBox],
        [
          BEARER_PROFILE,
          new BearerConnectionProfile({
            connectionId: pausedBox.connectionId,
            environmentId: pausedBox.environmentId,
            label: pausedBox.label,
            httpBaseUrl: "https://paused-box.example.test",
            wsBaseUrl: "wss://paused-box.example.test",
          }),
        ],
        [
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
          [pausedBox.connectionId, BEARER_CREDENTIAL],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        for (const target of [BEARER_TARGET, pausedBox]) {
          yield* awaitConnectionState(
            registry,
            target.environmentId,
            (state) => state.phase === "connected",
          );
        }
        const runTargets = Effect.gen(function* () {
          const entries = yield* SubscriptionRef.get(registry.entries);
          const connections = new Map<EnvironmentId, EnvironmentConnectionPresentation>();
          for (const [environmentId, entry] of entries) {
            connections.set(
              environmentId,
              presentEnvironmentConnection(yield* registry.state(environmentId), entry.target),
            );
          }
          const { environments, redirect } = newChatRunTargets({
            environments: [BEARER_TARGET, pausedBox].map(({ environmentId }) => ({
              environmentId,
            })),
            environmentState: (environmentId) => ({
              connection: connections.get(environmentId),
            }),
            environmentId: BEARER_TARGET.environmentId,
            managerConfig: null,
            boxes: new Set(),
          });
          return { offered: environments.map(({ environmentId }) => environmentId), redirect };
        });
        expect(yield* runTargets).toEqual({
          offered: ["environment-bearer", "environment-paused-box"],
          redirect: null,
        });

        yield* registry.syncHostBoxes(TARGET.environmentId, [
          provisionedBox(
            TARGET.environmentId,
            listedBox(BEARER_TARGET.environmentId, { lifecycle: "disposed" }),
          ),
          provisionedBox(
            TARGET.environmentId,
            listedBox(EnvironmentId.make("environment-not-saved"), { lifecycle: "disposed" }),
          ),
        ]);

        // Marked the box it was, it stops dialing, and its history reads as a missing workspace.
        const disposed = yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "available",
        );
        expect(disposed.retryAt).toBeNull();
        const entries = yield* SubscriptionRef.get(registry.entries);
        expect(entries.get(BEARER_TARGET.environmentId)?.target).toEqual(
          new BearerConnectionTarget({
            ...BEARER_TARGET,
            label: "t3code · E2B",
            box: { managerId: TARGET.environmentId },
            workspaceStatus: "missing",
          }),
        );
        expect(entries.has(EnvironmentId.make("environment-not-saved"))).toBe(false);
        expect(
          presentEnvironmentConnection(disposed, entries.get(BEARER_TARGET.environmentId)!.target),
        ).toEqual({
          phase: "error",
          error: "This workspace no longer exists. Its saved conversation is still available.",
          traceId: null,
          blockedReason: "workspace-missing",
        });
        expect(entries.get(pausedBox.environmentId)?.target).toEqual(pausedBox);
        expect((yield* registry.state(pausedBox.environmentId)).phase).toBe("connected");
        expect(yield* runTargets).toEqual({
          offered: ["environment-paused-box"],
          redirect: {
            kind: "environment",
            environment: { environmentId: "environment-paused-box" },
          },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("follows the replacement supervisor when an environment is re-paired unchanged", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        );
        const followedPhase = yield* Ref.make<SupervisorConnectionState["phase"] | null>(null);
        const followerSees = Effect.fn("followerSees")(function* (
          phase: SupervisorConnectionState["phase"],
        ) {
          for (let turn = 0; turn < 100 && (yield* Ref.get(followedPhase)) !== phase; turn += 1) {
            yield* Effect.yieldNow;
          }
          return yield* Ref.get(followedPhase);
        });
        yield* registry.stateChanges(BEARER_TARGET.environmentId).pipe(
          Stream.runForEach((state) => Ref.set(followedPhase, state.phase)),
          Effect.forkScoped,
        );
        expect(yield* followerSees("connected")).toBe("connected");
        const [session] = yield* Ref.get(harness.sessions);
        yield* Deferred.fail(
          session!.closed,
          new ConnectionTransientError({ reason: "transport", detail: "Workspace paused." }),
        );
        expect(yield* followerSees("backoff")).toBe("backoff");

        yield* registry.register(
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: new BearerConnectionCredential({ token: "re-paired-token" }),
          }),
        );
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* followerSees("connected")).toBe("connected");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});

describe("EnvironmentRegistry.syncHostBoxes", () => {
  const listing = (...rows: ReadonlyArray<DiscoveredProvisionedEnvironment>) =>
    rows.map((row) => provisionedBox(TARGET.environmentId, row));

  it.effect("a paused chat box its host lists appears with its chat and is never dialed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(listedBox(CHAT_BOX_ID, { lifecycle: "paused", chat: chatAt(4) })),
        );
        yield* TestClock.adjust("1 hour");

        const entries = yield* SubscriptionRef.get(registry.entries);
        expect([...entries.keys()]).toEqual([TARGET.environmentId, CHAT_BOX_ID]);
        expect(entries.get(CHAT_BOX_ID)).toEqual({
          target: UNPAIRED_CHAT_BOX,
          profile: Option.none(),
          enabled: true,
        });
        expect((yield* Ref.get(harness.storedTargets)).get(CHAT_BOX_ID)).toEqual(UNPAIRED_CHAT_BOX);
        expect((yield* Ref.get(harness.shellCache)).get(CHAT_BOX_ID)).toEqual(seededShell(4));
        expect((yield* registry.state(CHAT_BOX_ID)).phase).toBe("available");
        expect(yield* Ref.get(harness.dialed)).toEqual([TARGET.environmentId]);
        expect(yield* Ref.get(harness.attaches)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "opening an unpaired box pairs once through its host and connects; reopening and a reload reuse that pairing",
    () =>
      Effect.gen(function* () {
        const row = listedBox(CHAT_BOX_ID, { chat: chatAt(4) });
        const harness = yield* makeHarness([TARGET], [], [], { listProvisioned: [row] });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* registry.syncHostBoxes(TARGET.environmentId, listing(row));

          const chat = yield* Scope.make();
          yield* registry.demand(CHAT_BOX_ID).pipe(Scope.provide(chat));
          yield* awaitConnectionState(registry, CHAT_BOX_ID, (s) => s.phase === "connected");
          expect(yield* Ref.get(harness.attaches)).toEqual([row.requestId]);
          expect((yield* Ref.get(harness.redemptions)).map(({ pairingUrl }) => pairingUrl)).toEqual(
            ["https://environment-chat-box.example.test/pair#token=minted"],
          );
          expect(
            (yield* Ref.get(harness.storedCredentials)).get(UNPAIRED_CHAT_BOX.connectionId),
          ).toEqual(new BearerConnectionCredential({ token: "box-token-1" }));
          expect((yield* Ref.get(harness.storedTargets)).get(CHAT_BOX_ID)).toEqual(
            UNPAIRED_CHAT_BOX,
          );

          yield* Scope.close(chat, Exit.void);
          yield* awaitConnectionState(registry, CHAT_BOX_ID, (s) => s.phase === "available");
          yield* registry.demand(CHAT_BOX_ID);
          yield* awaitConnectionState(registry, CHAT_BOX_ID, (s) => s.phase === "connected");
          expect(yield* Ref.get(harness.attaches)).toEqual([row.requestId]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);

        yield* Effect.gen(function* () {
          const reloaded = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* reloaded.start;
          yield* awaitConnectionState(
            reloaded,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* reloaded.demand(CHAT_BOX_ID);
          yield* awaitConnectionState(reloaded, CHAT_BOX_ID, (s) => s.phase === "connected");
          expect(yield* Ref.get(harness.attaches)).toEqual([row.requestId]);
          expect(
            (yield* Ref.get(harness.storedCredentials)).get(UNPAIRED_CHAT_BOX.connectionId),
          ).toEqual(new BearerConnectionCredential({ token: "box-token-1" }));
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an unpaired paused box is woken through its host before it pairs", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Ref.make<DiscoveredProvisionedEnvironment["lifecycle"]>("paused");
      const resumes = yield* Ref.make(0);
      const harness = yield* makeHarness([TARGET], [], [], {
        lists: Ref.get(lifecycle).pipe(
          Effect.map((current) => [listedBox(CHAT_BOX_ID, { lifecycle: current })]),
        ),
        resume: () =>
          Ref.update(resumes, (count) => count + 1).pipe(
            Effect.andThen(Ref.set(lifecycle, "active")),
            Effect.as({ kind: "resumed" as const }),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(registry, TARGET.environmentId, (s) => s.phase === "connected");
        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(listedBox(CHAT_BOX_ID, { lifecycle: "paused" })),
        );
        // The box's own supervisor, which pairing keeps, sees every phase of the one dial.
        const supervisor = yield* registry.run(
          CHAT_BOX_ID,
          EnvironmentSupervisor.EnvironmentSupervisor,
        );
        const phases = yield* Ref.make<ReadonlyArray<SupervisorConnectionState["phase"]>>([]);
        const following = yield* Deferred.make<void>();
        yield* SubscriptionRef.changes(supervisor.state).pipe(
          Stream.runForEach((state) =>
            Ref.update(phases, (current) => [...current, state.phase]).pipe(
              Effect.andThen(Deferred.succeed(following, undefined)),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(following);

        yield* registry.demand(CHAT_BOX_ID);
        yield* awaitConnectionState(registry, CHAT_BOX_ID, (s) => s.phase === "connected");
        expect(yield* registry.run(CHAT_BOX_ID, EnvironmentSupervisor.EnvironmentSupervisor)).toBe(
          supervisor,
        );

        expect([...new Set(yield* Ref.get(phases))]).toEqual([
          "available",
          "connecting",
          "waking",
          "connected",
        ]);
        expect(yield* Ref.get(resumes)).toBe(1);
        expect((yield* Ref.get(harness.attaches)).length).toBe(1);
        expect(yield* Ref.get(harness.dialed)).toEqual([TARGET.environmentId, CHAT_BOX_ID]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a disposed box this device never opened disappears; one it opened keeps its history",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          [TARGET, HOST_BOX],
          [HOST_BOX_PROFILE],
          [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
        );
        yield* Ref.update(harness.shellCache, (cache) =>
          new Map(cache).set(HOST_BOX.environmentId, CACHED_SNAPSHOT),
        );

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* registry.syncHostBoxes(
            TARGET.environmentId,
            listing(listedBox(CHAT_BOX_ID, { chat: chatAt(4) }), listedBox(HOST_BOX.environmentId)),
          );
          yield* registry.syncHostBoxes(
            TARGET.environmentId,
            listing(
              listedBox(CHAT_BOX_ID, { lifecycle: "disposed" }),
              listedBox(HOST_BOX.environmentId, { lifecycle: "disposed" }),
            ),
          );

          const entries = yield* SubscriptionRef.get(registry.entries);
          expect(entries.has(CHAT_BOX_ID)).toBe(false);
          expect((yield* Ref.get(harness.storedTargets)).has(CHAT_BOX_ID)).toBe(false);
          expect((yield* Ref.get(harness.shellCache)).has(CHAT_BOX_ID)).toBe(false);
          expect(entries.get(HOST_BOX.environmentId)?.target).toEqual(
            new BearerConnectionTarget({
              ...HOST_BOX,
              label: "t3code · E2B",
              workspaceStatus: "missing",
            }),
          );
          expect((yield* Ref.get(harness.shellCache)).get(HOST_BOX.environmentId)).toEqual(
            CACHED_SNAPSHOT,
          );
          expect((yield* Ref.get(harness.storedCredentials)).get(HOST_BOX.connectionId)).toEqual(
            BEARER_CREDENTIAL,
          );
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("a box's label follows its host without replacing its connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [TARGET, HOST_BOX],
        [HOST_BOX_PROFILE],
        [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.demand(HOST_BOX.environmentId);
        yield* awaitConnectionState(
          registry,
          HOST_BOX.environmentId,
          (s) => s.phase === "connected",
        );
        const supervisor = registry.run(
          HOST_BOX.environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor,
        );
        const before = yield* supervisor;

        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(listedBox(HOST_BOX.environmentId)),
        );

        expect(yield* supervisor).toBe(before);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(HOST_BOX.environmentId)?.target.label,
        ).toBe("t3code · E2B");
        expect((yield* Ref.get(harness.storedTargets)).get(HOST_BOX.environmentId)?.label).toBe(
          "t3code · E2B",
        );
        expect((yield* Ref.get(harness.storedCredentials)).get(HOST_BOX.connectionId)).toEqual(
          BEARER_CREDENTIAL,
        );
        expect((yield* registry.state(HOST_BOX.environmentId)).phase).toBe("connected");
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "a host's newer read of a chat updates an idle box's cache, never a connected one's",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          [TARGET, HOST_BOX],
          [HOST_BOX_PROFILE],
          [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
        );
        const subagentThread = { ...CHAT_THREAD, id: ThreadId.make("thread-subagent") };
        yield* Ref.update(harness.shellCache, (cache) =>
          new Map(cache).set(HOST_BOX.environmentId, {
            ...CACHED_SNAPSHOT,
            threads: [subagentThread],
          }),
        );
        const listChat = (sequence: number) =>
          listing(
            listedBox(HOST_BOX.environmentId, { label: "e2b.local", chat: chatAt(sequence) }),
          );
        const cachedSequence = Ref.get(harness.shellCache).pipe(
          Effect.map((cache) => cache.get(HOST_BOX.environmentId)?.snapshotSequence),
        );

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* registry.syncHostBoxes(TARGET.environmentId, listChat(5));
          expect(yield* cachedSequence).toBe(5);
          yield* registry.syncHostBoxes(TARGET.environmentId, listChat(3));
          expect(yield* cachedSequence).toBe(5);

          const chat = yield* Scope.make();
          yield* registry.demand(HOST_BOX.environmentId).pipe(Scope.provide(chat));
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (s) => s.phase === "connected",
          );
          yield* registry.syncHostBoxes(TARGET.environmentId, listChat(9));
          expect(yield* cachedSequence).toBe(5);

          yield* Scope.close(chat, Exit.void);
          yield* awaitConnectionState(
            registry,
            HOST_BOX.environmentId,
            (s) => s.phase === "available",
          );
          yield* registry.syncHostBoxes(TARGET.environmentId, listChat(9));
          expect(yield* cachedSequence).toBe(9);
          expect(
            (yield* Ref.get(harness.shellCache))
              .get(HOST_BOX.environmentId)
              ?.threads.map(({ id }) => id),
          ).toEqual(["thread-subagent", "thread-cloud-chat"]);
          expect(
            [...(yield* SubscriptionRef.get(registry.hostChats))].map(
              ([environmentId, { managerId, chat }]) => [environmentId, managerId, chat.sequence],
            ),
          ).toEqual([[HOST_BOX.environmentId, TARGET.environmentId, 9]]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("holds only chats it could decode, so the host sends an unreadable card again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      const otherBoxId = EnvironmentId.make("environment-other-chat-box");
      // A card from a host still on V1 shells: it fails to decode, so the box lists no chat.
      const v1Chat = (sequence: number) =>
        ({
          sequence,
          project: CHAT_PROJECT,
          thread: {
            id: CHAT_THREAD.id,
            projectId: CHAT_PROJECT.id,
            title: CHAT_THREAD.title,
            session: null,
            latestTurn: null,
            hasPendingApprovals: false,
          },
        }) as unknown as ProvisionedChat;
      const heldSequences = (registry: EnvironmentRegistry.EnvironmentRegistry["Service"]) =>
        SubscriptionRef.get(registry.hostChats).pipe(
          Effect.map((held) =>
            [...held].map(([environmentId, { chat }]) => [environmentId, chat.sequence]),
          ),
        );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(listedBox(CHAT_BOX_ID, { chat: chatAt(4) })),
        );
        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(
            listedBox(CHAT_BOX_ID, { chat: v1Chat(7) }),
            listedBox(otherBoxId, { chat: v1Chat(3) }),
          ),
        );
        expect(yield* heldSequences(registry)).toEqual([[CHAT_BOX_ID, 4]]);

        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(listedBox(CHAT_BOX_ID, { chat: chatAt(7) })),
        );
        expect(yield* heldSequences(registry)).toEqual([[CHAT_BOX_ID, 7]]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("pairing a box its host already listed keeps the host's name for it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.syncHostBoxes(TARGET.environmentId, listing(listedBox(CHAT_BOX_ID)));
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              ...UNPAIRED_CHAT_BOX,
              label: "e2b.local",
            }),
            profile: new BearerConnectionProfile({
              connectionId: UNPAIRED_CHAT_BOX.connectionId,
              environmentId: CHAT_BOX_ID,
              label: "e2b.local",
              httpBaseUrl: "https://environment-chat-box.example.test",
              wsBaseUrl: "wss://environment-chat-box.example.test",
            }),
            credential: BEARER_CREDENTIAL,
          }),
        );

        expect((yield* Ref.get(harness.storedTargets)).get(CHAT_BOX_ID)).toEqual(UNPAIRED_CHAT_BOX);
        expect(
          (yield* Ref.get(harness.storedCredentials)).get(UNPAIRED_CHAT_BOX.connectionId),
        ).toEqual(BEARER_CREDENTIAL);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "a box that pairs while its host's list is applied keeps its pairing, as missing once disposed",
    () =>
      Effect.gen(function* () {
        const planning = yield* Deferred.make<void>();
        const paired = yield* Deferred.make<void>();
        const harness = yield* makeHarness([TARGET], [], [], {
          listProvisioned: [listedBox(CHAT_BOX_ID)],
          // The sync reads the box's cache after it took its snapshot of the catalog.
          beforeLoadShell: (environmentId) =>
            environmentId === CHAT_BOX_ID
              ? Deferred.succeed(planning, undefined).pipe(Effect.andThen(Deferred.await(paired)))
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (s) => s.phase === "connected",
          );
          yield* registry.syncHostBoxes(TARGET.environmentId, listing(listedBox(CHAT_BOX_ID)));
          const sync = yield* registry
            .syncHostBoxes(
              TARGET.environmentId,
              listing(listedBox(CHAT_BOX_ID, { lifecycle: "disposed", chat: chatAt(4) })),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(planning);
          yield* registry.demand(CHAT_BOX_ID);
          yield* awaitConnectionState(registry, CHAT_BOX_ID, (s) => s.phase === "connected");
          yield* Deferred.succeed(paired, undefined);
          yield* Fiber.join(sync);

          expect(
            (yield* Ref.get(harness.storedCredentials)).get(UNPAIRED_CHAT_BOX.connectionId),
          ).toEqual(new BearerConnectionCredential({ token: "box-token-1" }));
          const entry = (yield* SubscriptionRef.get(registry.entries)).get(CHAT_BOX_ID);
          expect(entry === undefined ? null : Option.getOrNull(entry.profile)?.connectionId).toBe(
            UNPAIRED_CHAT_BOX.connectionId,
          );
          // The host listed it disposed, so the pairing it kept reads as a missing workspace.
          expect(entry?.target).toEqual(
            new BearerConnectionTarget({ ...UNPAIRED_CHAT_BOX, workspaceStatus: "missing" }),
          );
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("the same list twice writes nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [TARGET, HOST_BOX],
        [HOST_BOX_PROFILE],
        [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
      );
      const list = listing(
        listedBox(CHAT_BOX_ID, { chat: chatAt(4) }),
        listedBox(HOST_BOX.environmentId, { lifecycle: "missing", chat: chatAt(7) }),
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.syncHostBoxes(TARGET.environmentId, list);
        const writes = yield* Ref.get(harness.registrationWrites);
        const cache = yield* Ref.get(harness.shellCache);
        const entries = yield* SubscriptionRef.get(registry.entries);
        expect(writes).toBe(3);

        yield* registry.syncHostBoxes(TARGET.environmentId, list);
        expect(yield* Ref.get(harness.registrationWrites)).toBe(3);
        expect(yield* Ref.get(harness.shellCache)).toBe(cache);
        expect(yield* SubscriptionRef.get(registry.entries)).toBe(entries);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removing a host forgets the unpaired boxes it lists and keeps the paired ones", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [TARGET, HOST_BOX],
        [HOST_BOX_PROFILE],
        [[HOST_BOX.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.syncHostBoxes(
          TARGET.environmentId,
          listing(listedBox(CHAT_BOX_ID, { chat: chatAt(4) }), listedBox(HOST_BOX.environmentId)),
        );
        yield* registry.remove(TARGET.environmentId);

        expect([...(yield* SubscriptionRef.get(registry.entries)).keys()]).toEqual([
          HOST_BOX.environmentId,
        ]);
        expect([...(yield* Ref.get(harness.storedTargets)).keys()]).toEqual([
          HOST_BOX.environmentId,
        ]);
        expect((yield* Ref.get(harness.shellCache)).has(CHAT_BOX_ID)).toBe(false);
        expect(yield* SubscriptionRef.get(registry.hostChats)).toEqual(new Map());
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
