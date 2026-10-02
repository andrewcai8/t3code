import {
  EnvironmentId,
  type OrchestrationShellSnapshot,
  type ProvisionedChat,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ProvisionedBox } from "../cloud/provisioning.ts";
import {
  BearerConnectionRegistration,
  BoxTargetRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type PlatformConnectionRegistration,
  type PrimaryConnectionRegistration,
  SshConnectionProfile,
  connectionRegistrationCatalogEntry,
  isUnpairedBox,
} from "./catalog.ts";
import { type BoxPairingPorts, PairingRedemption, pairBoxThroughHost } from "./boxPairing.ts";
import {
  type HostBoxSyncStep,
  type HostChat,
  chatShellSnapshot,
  planHostBoxSync,
} from "./hostBoxSync.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as Connectivity from "./connectivity.ts";
import {
  BearerConnectionTarget,
  type BoxAttachment,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type SupervisorConnectionState,
  connectionBox,
} from "./model.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import { credentialMissingError, profileMissingError, workspaceMissingError } from "./errors.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { UserPresence } from "./presence.ts";
import * as EnvironmentRpc from "../rpc/client.ts";
import {
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
} from "./githubRoutingPermissions.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);

/** Under a third of the host's 15-minute lease, so one missed beat never lets it lapse. */
const BOX_LEASE_HEARTBEAT_INTERVAL = "4 minutes";
/** Past a host's 15-second connection attempt. */
const HOST_SETTLE_TIMEOUT = "20 seconds";

export class EnvironmentNotRegisteredError extends Schema.TaggedError<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class PlatformEnvironmentRemovalError extends Schema.TaggedError<PlatformEnvironmentRemovalError>()(
  "PlatformEnvironmentRemovalError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Platform-managed environment ${this.environmentId} cannot be removed.`;
  }
}

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly start: Effect.Effect<void>;
    readonly register: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly registerPlatform: (registration: PrimaryConnectionRegistration) => Effect.Effect<void>;
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) => Effect.Effect<void>;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | EnvironmentNotRegisteredError
      | PlatformEnvironmentRemovalError
    >;
    readonly removeRelayEnvironments: () => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | PlatformEnvironmentRemovalError
    >;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * Holds a box connected for as long as the calling scope is open. A box connects only while
     * something demands it; every other environment connects whenever it is enabled, so
     * demanding one changes nothing.
     */
    readonly demand: (environmentId: EnvironmentId) => Effect.Effect<void, never, Scope.Scope>;
    /** The environments something demands right now. */
    readonly demanded: SubscriptionRef.SubscriptionRef<ReadonlySet<EnvironmentId>>;
    /**
     * Marks saved connections as the boxes they reach, so they stop being user environments.
     * Anything not saved, not a bearer connection, or already marked is skipped, and so is a
     * host that provisions boxes: one named in `boxes` or by a saved box.
     */
    readonly markBoxes: (
      boxes: ReadonlyArray<{ readonly environmentId: EnvironmentId } & BoxAttachment>,
    ) => Effect.Effect<void>;
    /** Makes a saved connection marked as a box an ordinary environment again. */
    readonly unmarkBox: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | EnvironmentNotRegisteredError
    >;
    readonly markWorkspaceMissing: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | EnvironmentNotRegisteredError
    >;
    /**
     * Brings this device's boxes of `managerId` in line with the host's list, the source of truth
     * for which cloud chats exist. A chat box this device never saw is saved unpaired with its
     * chat cached, so it lists without a dial; opening it pairs it once. It never dials, pairs or
     * wakes a box, and the same list twice writes nothing.
     */
    readonly syncHostBoxes: (
      managerId: EnvironmentId,
      boxes: ReadonlyArray<ProvisionedBox>,
    ) => Effect.Effect<void>;
    /**
     * The chat each box's host last listed, as this runtime received it. A host list asks only for
     * chats newer than these, and a box's shell that is not live takes a newer one.
     */
    readonly hostChats: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, HostChat>>;
    /**
     * Switches a saved environment on or off. Off drops the socket, stops the
     * retry ladder, and persists so the next launch stays off. Registration,
     * credentials, and cache are untouched.
     */
    readonly setEnabled: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<
      void,
      | EnvironmentNotRegisteredError
      | Persistence.ConnectionPersistenceError
      | ConnectionBlockedError
    >;
    readonly setCompatibility: (
      environmentId: EnvironmentId,
      error: ConnectionBlockedError | null,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly runStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly followStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>>;
  }
>()("@t3tools/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registryScope = yield* Scope.Scope;
  const storage = yield* Persistence.ConnectionTargetStore;
  const registrations = yield* Persistence.ConnectionRegistrationStore;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const githubRoutingPermissions = yield* GitHubRoutingPermissions;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const presence = yield* UserPresence;
  const pairing = yield* PairingRedemption;
  // A box is kept awake and woken only while its user is here.
  const userHere = presence.present.pipe(
    Stream.runHead,
    Effect.map((present) => Option.getOrElse(present, () => true)),
  );
  const userArrives = presence.present.pipe(
    Stream.filter((present) => present),
    Stream.runHead,
    Effect.asVoid,
  );
  const userReturns = presence.present.pipe(
    Stream.drop(1),
    Stream.filter((present) => present),
    Stream.runHead,
    Effect.asVoid,
  );
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const persistedTargets = yield* storage.list;
  const disabledEnvironmentIds = new Set(yield* storage.listDisabled);
  const initialEntries = new Map(
    yield* Effect.forEach(
      persistedTargets,
      Effect.fn("EnvironmentRegistry.loadCatalogEntry")(function* (target) {
        const profile =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();
        return [
          target.environmentId,
          {
            target,
            profile,
            enabled: !disabledEnvironmentIds.has(target.environmentId),
          } satisfies ConnectionCatalogEntry,
        ] as const;
      }),
      { concurrency: "unbounded" },
    ),
  );
  const entries =
    yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(initialEntries);
  const networkStatus = yield* SubscriptionRef.make(yield* connectivity.status);
  const serviceScopes = yield* SubscriptionRef.make<
    ReadonlyMap<EnvironmentId, EnvironmentServiceScope>
  >(new Map());
  const platformEnvironmentIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  const persistedTargetsByEnvironment = yield* Ref.make<
    ReadonlyMap<EnvironmentId, ConnectionTarget>
  >(new Map(persistedTargets.map((target) => [target.environmentId, target])));
  interface LeaseLock {
    readonly semaphore: Semaphore.Semaphore;
    readonly users: number;
  }

  const leaseLocks = yield* Ref.make<ReadonlyMap<EnvironmentId, LeaseLock>>(new Map());
  const demandCounts = yield* Ref.make<ReadonlyMap<EnvironmentId, number>>(new Map());
  const demanded = yield* SubscriptionRef.make<ReadonlySet<EnvironmentId>>(new Set());
  const hostChats = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, HostChat>>(new Map());
  const leaseLocksGuard = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);

  const withLeaseLock = <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      leaseLocksGuard.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(leaseLocks);
          const existing = current.get(environmentId);
          if (existing !== undefined) {
            yield* Ref.set(
              leaseLocks,
              new Map(current).set(environmentId, {
                semaphore: existing.semaphore,
                users: existing.users + 1,
              }),
            );
            return existing.semaphore;
          }
          const semaphore = yield* Semaphore.make(1);
          yield* Ref.set(leaseLocks, new Map(current).set(environmentId, { semaphore, users: 1 }));
          return semaphore;
        }),
      ),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        leaseLocksGuard.withPermits(1)(
          Ref.update(leaseLocks, (current) => {
            const existing = current.get(environmentId);
            if (existing === undefined || existing.semaphore !== semaphore) {
              return current;
            }
            const next = new Map(current);
            if (existing.users === 1) {
              next.delete(environmentId);
            } else {
              next.set(environmentId, {
                semaphore,
                users: existing.users - 1,
              });
            }
            return next;
          }),
        ),
    ).pipe(Effect.withSpan("EnvironmentRegistry.withLeaseLock"));

  const getEntry = Effect.fn("EnvironmentRegistry.getEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({
        environmentId,
      });
    }
    return entry;
  });

  // Swaps a changed entry in without replacing its supervisor, so its socket and durable streams
  // stay; `installEntryLocked` would tear them down. Run under the entry's lease lock.
  const replaceEntryInPlace = Effect.fn("EnvironmentRegistry.replaceEntryInPlace")(function* (
    environmentId: EnvironmentId,
    next: ConnectionCatalogEntry,
  ) {
    const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
    if (lease !== undefined)
      yield* SubscriptionRef.update(serviceScopes, (current) =>
        new Map(current).set(environmentId, { ...lease, entry: next }),
      );
    yield* SubscriptionRef.update(entries, (current) => new Map(current).set(environmentId, next));
    return lease;
  });

  // A box connects only while demanded; everything else whenever it is enabled.
  const wantsConnection = Effect.fn("EnvironmentRegistry.wantsConnection")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    return (
      entry.enabled &&
      (connectionBox(entry.target) === null ||
        (yield* SubscriptionRef.get(demanded)).has(entry.target.environmentId))
    );
  });

  const closeServiceScope = Effect.fn("EnvironmentRegistry.closeServiceScope")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* SubscriptionRef.get(serviceScopes);
    const lease = current.get(environmentId);
    if (lease === undefined) {
      return;
    }
    const next = new Map(current);
    next.delete(environmentId);
    yield* SubscriptionRef.set(serviceScopes, next);
    yield* Scope.close(lease.scope, Exit.void);
  });

  const wakeRetryLater = (detail: string): EnvironmentSupervisor.BoxWakeOutcome => ({
    _tag: "RetryLater",
    error: new ConnectionTransientError({ reason: "not-serving", detail }),
  });
  const wakeUndelivered = (detail: string): EnvironmentSupervisor.BoxWakeOutcome => ({
    _tag: "Undelivered",
    error: new ConnectionTransientError({ reason: "not-serving", detail }),
  });

  // Whether a box's host can hear a wake now. A host still connecting is waited for, as a page load
  // dials both at once. A host this client does not know lets the wake run, which refuses it.
  const hostConnected = Effect.fn("EnvironmentRegistry.hostConnected")(function* (
    managerId: EnvironmentId,
  ) {
    if (!(yield* SubscriptionRef.get(entries)).has(managerId)) return true;
    const host = (yield* SubscriptionRef.get(serviceScopes)).get(managerId);
    if (host === undefined) return false;
    const settled = yield* SubscriptionRef.changes(host.supervisor.state).pipe(
      Stream.filter((state) => state.phase !== "connecting"),
      Stream.runHead,
      Effect.timeoutOption(HOST_SETTLE_TIMEOUT),
    );
    return Option.flatten(settled).pipe(Option.exists((state) => state.phase === "connected"));
  });

  // The RPC client ends a call whose session is closed under it as interrupted rather than failed,
  // which would end the background loop that made it. A box's calls to its host fail instead.
  const runOnHost = <A, E, R>(
    managerId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | EnvironmentNotRegisteredError | EnvironmentRpc.EnvironmentRpcUnavailableError,
    Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
  > =>
    run(managerId, effect).pipe(
      Effect.catchCauseIf(Cause.hasInterruptsOnly, () =>
        Effect.fail(
          new EnvironmentRpc.EnvironmentRpcUnavailableError({
            environmentId: managerId,
            message: "This chat's cloud host disconnected before it answered.",
          }),
        ),
      ),
    );

  // Resumes a box through its host. The host joins concurrent resumes of one box and finishes a
  // resume this request stops waiting for, so there is no client timeout.
  const wakeBox = (
    environmentId: EnvironmentId,
    managerId: EnvironmentId,
  ): Effect.Effect<EnvironmentSupervisor.BoxWakeOutcome> =>
    Effect.gen(function* () {
      const result = yield* runOnHost(
        managerId,
        EnvironmentRpc.request(WS_METHODS.environmentControlResume, { environmentId }),
      ).pipe(Effect.provideService(EnvironmentRpc.EnvironmentRpcShowsOwnProgress, true));
      if (result.kind === "resumed") {
        return { _tag: "Resumed" } as const;
      }
      switch (result.reason) {
        case "missing":
          // Marking replaces this box's supervisor, which is running this wake.
          yield* markWorkspaceMissing(environmentId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not mark a gone workspace missing.", {
                environmentId,
                error,
              }),
            ),
            Effect.forkIn(registryScope),
          );
          return { _tag: "Refused", error: workspaceMissingError() } as const;
        case "not-provisioned":
          return {
            _tag: "Refused",
            error: new ConnectionBlockedError({ reason: "configuration", detail: result.message }),
          } as const;
        case "unknown":
          return wakeRetryLater(result.message);
      }
    }).pipe(
      Effect.catchTag("EnvironmentNotRegisteredError", (error) =>
        Effect.succeed<EnvironmentSupervisor.BoxWakeOutcome>({
          _tag: "Refused",
          error: new ConnectionBlockedError({ reason: "configuration", detail: error.message }),
        }),
      ),
      Effect.catchTags({
        EnvironmentRpcUnavailableError: (error) => Effect.succeed(wakeUndelivered(error.message)),
        RpcClientError: (error) => Effect.succeed(wakeUndelivered(error.message)),
      }),
      Effect.catch((error) => Effect.succeed(wakeRetryLater(error.message))),
      Effect.withSpan("EnvironmentRegistry.wakeBox"),
    );

  // Every client whose user has a box's chat open keeps its lease alive, not only the one that
  // started it, so a phone or a second tab does not let the host pause the box under the open
  // chat. A hidden or untouched client does not, so a forgotten tab lets the box idle. It runs
  // only while this client is connected to the box, which proves it holds the box's credential;
  // the host still requires an operate session and an active, claimed lease to renew one.
  const keepBoxAlive = (
    environmentId: EnvironmentId,
    managerId: EnvironmentId,
  ): Effect.Effect<void> => {
    const renew = Effect.gen(function* () {
      const listed = yield* runOnHost(
        managerId,
        EnvironmentRpc.request(WS_METHODS.environmentControlListProvisioned, {
          environmentIds: [environmentId],
        }),
      );
      const lease = listed.find(
        (box) => box.environmentId === environmentId && box.lifecycle === "active",
      );
      if (lease === undefined) return;
      const touched = yield* runOnHost(
        managerId,
        EnvironmentRpc.request(WS_METHODS.environmentControlTouch, { leaseId: lease.leaseId }),
      );
      if (touched.kind === "refused" && touched.reason === "missing")
        // Marking replaces this box's supervisor, which is running this heartbeat.
        yield* markWorkspaceMissing(environmentId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not mark a gone workspace missing.", { environmentId, error }),
          ),
          Effect.forkIn(registryScope),
        );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not renew a cloud box's lease.", { environmentId, error }),
      ),
    );
    // A beat waits for the user, and their return renews at once, ahead of the next beat.
    return Effect.gen(function* () {
      for (;;) {
        yield* userArrives;
        yield* renew;
        yield* Effect.raceFirst(Effect.sleep(BOX_LEASE_HEARTBEAT_INTERVAL), userReturns);
      }
    }).pipe(Effect.withSpan("EnvironmentRegistry.keepBoxAlive"));
  };

  // A user coming back retries each box that is down at once, waking it without the wait a box
  // left alone backs off to.
  yield* userReturns.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        for (const lease of (yield* SubscriptionRef.get(serviceScopes)).values()) {
          if (connectionBox(lease.entry.target) === null) continue;
          const state = yield* SubscriptionRef.get(lease.supervisor.state);
          // A wake in flight is left to finish; a retry would start it over.
          if (state.desired && state.phase !== "connected" && state.phase !== "waking")
            yield* lease.supervisor.retryNow;
        }
      }),
    ),
    Effect.forever,
    Effect.forkIn(registryScope),
  );

  const hostFailure = (error: {
    readonly _tag: string;
    readonly message: string;
  }): ConnectionAttemptError => {
    switch (error._tag) {
      case "EnvironmentNotRegisteredError":
        return new ConnectionBlockedError({
          reason: "configuration",
          detail: "This chat's cloud host is not saved on this device.",
        });
      case "EnvironmentAuthorizationError":
        return new ConnectionBlockedError({ reason: "permission", detail: error.message });
      default:
        return new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: error.message,
        });
    }
  };

  // The host's side of pairing one of its boxes: its list and attach, and the address this
  // client reaches it by.
  const hostPairingPorts = (
    environmentId: EnvironmentId,
    managerId: EnvironmentId,
  ): BoxPairingPorts => ({
    lookUp: Effect.gen(function* () {
      if (!(yield* hostConnected(managerId)))
        return yield* new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "This chat's cloud host is not connected.",
        });
      const listed = yield* runOnHost(
        managerId,
        EnvironmentRpc.request(WS_METHODS.environmentControlListProvisioned, {
          environmentIds: [environmentId],
        }),
      ).pipe(Effect.mapError(hostFailure));
      return Option.fromUndefinedOr(listed.find((row) => row.environmentId === environmentId));
    }),
    attach: (requestId) =>
      runOnHost(
        managerId,
        EnvironmentRpc.request(WS_METHODS.environmentControlAttach, { requestId }),
      ).pipe(Effect.mapError(hostFailure)),
    hostHttpBaseUrl: run(
      managerId,
      EnvironmentSupervisor.EnvironmentSupervisor.pipe(
        Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.prepared)),
      ),
    ).pipe(
      Effect.map(Option.map((prepared) => prepared.httpBaseUrl)),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.succeedNone),
    ),
    redeem: pairing.redeem,
  });

  // Saves the pairing a box's dial obtained into its entry in place, keeping the host's label
  // for it, so the same attempt dials with it and no replacement supervisor pairs again.
  const savePairing = (environmentId: EnvironmentId, registration: BearerConnectionRegistration) =>
    withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const current = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (current === undefined) return yield* workspaceMissingError();
        if (current.target._tag !== "BearerConnectionTarget" || !isUnpairedBox(current))
          return current;
        const target = new BearerConnectionTarget({
          ...current.target,
          connectionId: registration.target.connectionId,
        });
        yield* registrations.register(
          new BearerConnectionRegistration({
            target,
            profile: registration.profile,
            credential: registration.credential,
          }),
        );
        yield* Ref.update(persistedTargetsByEnvironment, (persisted) =>
          new Map(persisted).set(environmentId, target),
        );
        const next: ConnectionCatalogEntry = {
          ...current,
          target,
          profile: Option.some(registration.profile),
        };
        yield* replaceEntryInPlace(environmentId, next);
        return next;
      }),
    ).pipe(
      Effect.catchTag("ConnectionPersistenceError", (error) =>
        Effect.fail(
          new ConnectionBlockedError({
            reason: "configuration",
            detail: `This device could not save its pairing with this chat's cloud machine: ${error.message}`,
          }),
        ),
      ),
    );

  // A box this device never paired pairs through its host inside its dial, so a paused one wakes
  // first and the pairing happens at most once per device: every later dial finds it saved.
  const boxDriver = (environmentId: EnvironmentId, managerId: EnvironmentId) =>
    ConnectionDriver.ConnectionDriver.of({
      connect: (captured, reportProgress) =>
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(environmentId) ?? captured;
          if (
            !isUnpairedBox(entry) ||
            (entry.target._tag === "BearerConnectionTarget" &&
              entry.target.workspaceStatus === "missing")
          )
            return yield* driver.connect(entry, reportProgress);
          yield* reportProgress({ stage: "preparing" });
          const registration = yield* pairBoxThroughHost(
            { environmentId, managerId },
            hostPairingPorts(environmentId, managerId),
          );
          return yield* driver.connect(
            yield* savePairing(environmentId, registration),
            reportProgress,
          );
        }),
    });

  const createServiceScope = Effect.fn("EnvironmentRegistry.createServiceScope")(
    (entry: ConnectionCatalogEntry) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const environmentId = entry.target.environmentId;
          const scope = yield* Scope.fork(registryScope);
          const box = connectionBox(entry.target);
          const supervisor = yield* EnvironmentSupervisor.make(entry, {
            initiallyDesired: false,
            ...(box === null
              ? {}
              : {
                  wake: wakeBox(environmentId, box.managerId),
                  mayWake: Effect.map(
                    Effect.all([userHere, hostConnected(box.managerId)]),
                    ([here, connected]) => here && connected,
                  ),
                  keepAlive: keepBoxAlive(environmentId, box.managerId),
                }),
          }).pipe(
            Effect.provideService(Connectivity.Connectivity, connectivity),
            Effect.provideService(
              ConnectionDriver.ConnectionDriver,
              box === null ? driver : boxDriver(environmentId, box.managerId),
            ),
            Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          if (yield* wantsConnection(entry)) {
            yield* supervisor.connect;
          }
          yield* SubscriptionRef.update(serviceScopes, (current) => {
            const next = new Map(current);
            next.set(environmentId, { entry, supervisor, scope });
            return next;
          });
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.runForEach((state) =>
              state.phase === "blocked" && state.lastFailure?.reason === "unsupported"
                ? setCompatibility(environmentId, state.lastFailure).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("Could not disable an unsupported environment.", {
                        environmentId,
                        error,
                      }),
                    ),
                  )
                : Effect.void,
            ),
            Effect.forkIn(scope),
          );
          return supervisor;
        }),
      ),
  );

  const acquireSupervisor = Effect.fn("EnvironmentRegistry.acquireSupervisor")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* getEntry(environmentId);
        const existing = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (existing !== undefined) {
          if (Equal.equals(existing.entry, entry)) {
            return existing.supervisor;
          }
          yield* closeServiceScope(environmentId);
        }
        return yield* createServiceScope(entry);
      }),
    );
  });

  const run: EnvironmentRegistry["Service"]["run"] = Effect.fn("EnvironmentRegistry.run")(
    function* <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) {
      const supervisor = yield* acquireSupervisor(environmentId);
      return yield* Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
    },
  );

  const runStream: EnvironmentRegistry["Service"]["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  // Re-registering an unchanged entry replaces the supervisor without changing
  // the catalog, so followers track the lease itself rather than the entry.
  const followCurrentSupervisor = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(serviceScopes)),
      SubscriptionRef.changes(serviceScopes),
    ).pipe(
      Stream.map((current) => current.get(environmentId)?.supervisor),
      Stream.filter(Predicate.isNotUndefined),
      Stream.changesWith((left, right) => left === right),
      Stream.switchMap((supervisor) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(entries)),
      SubscriptionRef.changes(entries),
    ).pipe(
      Stream.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: () =>
            Stream.unwrap(
              acquireSupervisor(environmentId).pipe(
                Effect.match({
                  onFailure: () => Stream.empty,
                  onSuccess: () => followCurrentSupervisor(environmentId, stream),
                }),
              ),
            ),
        }),
      ),
    );

  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) {
      return;
    }
    yield* Effect.forEach(
      persistedTargets,
      (target) =>
        acquireSupervisor(target.environmentId).pipe(
          Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
        ),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
  }).pipe(Effect.withSpan("EnvironmentRegistry.start"));

  const installEntryLocked = Effect.fn("EnvironmentRegistry.installEntryLocked")(function* (
    entry: ConnectionCatalogEntry,
    options?: { readonly retainEquivalentRuntime?: boolean },
  ) {
    const target = entry.target;
    const previous = (yield* SubscriptionRef.get(entries)).get(target.environmentId);
    const existingScope = (yield* SubscriptionRef.get(serviceScopes)).get(target.environmentId);
    if (
      options?.retainEquivalentRuntime === true &&
      previous !== undefined &&
      Equal.equals(previous, entry) &&
      existingScope !== undefined &&
      Equal.equals(existingScope.entry, entry)
    ) {
      return;
    }

    yield* closeServiceScope(target.environmentId);
    yield* SubscriptionRef.update(entries, (current) => {
      const next = new Map(current);
      next.set(target.environmentId, entry);
      return next;
    });
    yield* createServiceScope(entry);
  });

  const register = Effect.fn("EnvironmentRegistry.register")(function* (
    requested: ConnectionRegistration,
  ) {
    const environmentId = requested.target.environmentId;
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        // Editing a saved environment must preserve its disabled state, and a box stays a box
        // however it is paired again.
        const previous = (yield* SubscriptionRef.get(entries)).get(environmentId);
        const previousBox = previous === undefined ? null : connectionBox(previous.target);
        // A pairing names a box for itself (`e2b.local`), so the saved name its host gave it stays.
        const registration =
          previous !== undefined &&
          previousBox !== null &&
          requested._tag === "BearerConnectionRegistration"
            ? new BearerConnectionRegistration({
                ...requested,
                target: new BearerConnectionTarget({
                  ...requested.target,
                  label: previous.target.label,
                  box: requested.target.box ?? previousBox,
                }),
              })
            : requested;
        const registered = connectionRegistrationCatalogEntry(registration);
        const entry: ConnectionCatalogEntry =
          previous === undefined
            ? registered
            : {
                ...registered,
                enabled: previous.enabled,
                ...(previous.unsupportedReason !== undefined &&
                gitHubRoutingConnectionKey(previous) === gitHubRoutingConnectionKey(registered)
                  ? { unsupportedReason: previous.unsupportedReason }
                  : {}),
              };
        if (
          previous !== undefined &&
          gitHubRoutingConnectionKey(previous) !== gitHubRoutingConnectionKey(entry)
        ) {
          yield* githubRoutingPermissions.forget(environmentId).pipe(
            Effect.mapError(
              (error) =>
                new Persistence.ConnectionPersistenceError({
                  operation: "register-connection",
                  message: error.message,
                }),
            ),
          );
        }
        yield* registrations.register(registration);
        yield* Ref.update(persistedTargetsByEnvironment, (current) => {
          const next = new Map(current);
          next.set(environmentId, registration.target);
          return next;
        });
        yield* installEntryLocked(entry);
      }),
    );
  });

  /**
   * Persists a saved bearer connection's target as `update` rewrites it, and replaces its
   * runtime. Platform and non-bearer environments, and targets `update` leaves alone (null),
   * are skipped.
   */
  const rewriteBearerTarget = Effect.fn("EnvironmentRegistry.rewriteBearerTarget")(function* (
    environmentId: EnvironmentId,
    update: (target: BearerConnectionTarget) => BearerConnectionTarget | null,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        const entry = yield* getEntry(environmentId);
        if (entry.target._tag !== "BearerConnectionTarget") {
          return;
        }
        const target = update(entry.target);
        if (target === null) {
          return;
        }
        if (target.box !== undefined) {
          // A box's target is saved alone, keeping its pairing, or its lack of one.
          yield* registrations.register(new BoxTargetRegistration({ target }));
        } else {
          if (
            Option.isNone(entry.profile) ||
            entry.profile.value._tag !== "BearerConnectionProfile"
          ) {
            return yield* profileMissingError(entry.target.connectionId);
          }
          const credential = yield* credentials.get(entry.target.connectionId);
          if (Option.isNone(credential)) {
            return yield* credentialMissingError(entry.target.connectionId);
          }
          yield* registrations.register(
            new BearerConnectionRegistration({
              target,
              profile: entry.profile.value,
              credential: credential.value,
            }),
          );
        }
        yield* Ref.update(persistedTargetsByEnvironment, (current) =>
          new Map(current).set(environmentId, target),
        );
        yield* installEntryLocked({ ...entry, target });
      }),
    );
  });

  const markWorkspaceMissing = (environmentId: EnvironmentId) =>
    rewriteBearerTarget(environmentId, (target) =>
      target.workspaceStatus === "missing"
        ? null
        : new BearerConnectionTarget({ ...target, workspaceStatus: "missing" }),
    ).pipe(Effect.withSpan("EnvironmentRegistry.markWorkspaceMissing"));

  const markBoxes: EnvironmentRegistry["Service"]["markBoxes"] = (boxes) =>
    Effect.gen(function* () {
      const managers = new Set<EnvironmentId>(boxes.map(({ managerId }) => managerId));
      for (const entry of (yield* SubscriptionRef.get(entries)).values()) {
        const box = connectionBox(entry.target);
        if (box !== null) managers.add(box.managerId);
      }
      return boxes.filter(
        ({ environmentId, managerId }) =>
          environmentId !== managerId && !managers.has(environmentId),
      );
    }).pipe(
      Effect.flatMap((boxes) =>
        Effect.forEach(
          boxes,
          ({ environmentId, managerId }) =>
            rewriteBearerTarget(environmentId, (target) =>
              target.box?.managerId === managerId
                ? null
                : new BearerConnectionTarget({ ...target, box: { managerId } }),
            ).pipe(
              Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
              Effect.catch((error) =>
                Effect.logWarning("Could not mark a saved connection as a box.", {
                  environmentId,
                  error,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.withSpan("EnvironmentRegistry.markBoxes"),
    );

  const unmarkBox = (environmentId: EnvironmentId) =>
    rewriteBearerTarget(environmentId, ({ box: _box, ...target }) =>
      _box === undefined ? null : new BearerConnectionTarget(target),
    ).pipe(Effect.withSpan("EnvironmentRegistry.unmarkBox"));

  const setDemand = Effect.fn("EnvironmentRegistry.setDemand")(function* (
    environmentId: EnvironmentId,
    change: 1 | -1,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const counts = yield* Ref.get(demandCounts);
        const count = Math.max(0, (counts.get(environmentId) ?? 0) + change);
        const nextCounts = new Map(counts);
        if (count === 0) nextCounts.delete(environmentId);
        else nextCounts.set(environmentId, count);
        yield* Ref.set(demandCounts, nextCounts);
        const wasDemanded = (yield* SubscriptionRef.get(demanded)).has(environmentId);
        if (wasDemanded === count > 0) return;
        yield* SubscriptionRef.update(demanded, (current) => {
          const next = new Set(current);
          if (count > 0) next.add(environmentId);
          else next.delete(environmentId);
          return next;
        });
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (entry === undefined || connectionBox(entry.target) === null) return;
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (lease === undefined) {
          if (count > 0) yield* createServiceScope(entry);
          return;
        }
        yield* (yield* wantsConnection(entry))
          ? lease.supervisor.connect
          : lease.supervisor.disconnect;
      }),
    );
  });

  const demand: EnvironmentRegistry["Service"]["demand"] = (environmentId) =>
    Effect.acquireRelease(setDemand(environmentId, 1), () => setDemand(environmentId, -1)).pipe(
      Effect.withSpan("EnvironmentRegistry.demand"),
    );

  const installPlatformRegistration = Effect.fn("EnvironmentRegistry.installPlatformRegistration")(
    function* (registration: PlatformConnectionRegistration) {
      const registered = connectionRegistrationCatalogEntry(registration);
      const target = registered.target;
      yield* withLeaseLock(
        target.environmentId,
        Effect.gen(function* () {
          const previous = (yield* SubscriptionRef.get(entries)).get(target.environmentId);
          const entry: ConnectionCatalogEntry =
            previous?.unsupportedReason !== undefined &&
            gitHubRoutingConnectionKey(previous) === gitHubRoutingConnectionKey(registered)
              ? { ...registered, enabled: false, unsupportedReason: previous.unsupportedReason }
              : registered;
          const persistedTarget = (yield* Ref.get(persistedTargetsByEnvironment)).get(
            target.environmentId,
          );
          if (
            persistedTarget !== undefined ||
            (previous !== undefined &&
              gitHubRoutingConnectionKey(previous) !== gitHubRoutingConnectionKey(entry))
          ) {
            const revoked = yield* githubRoutingPermissions.forget(target.environmentId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Could not clear GitHub routing permission for a platform environment.",
                  {
                    environmentId: target.environmentId,
                    error,
                  },
                ),
              ),
              Effect.exit,
            );
            if (Exit.isFailure(revoked)) return;
          }
          yield* Ref.update(platformEnvironmentIds, (current) => {
            const next = new Set(current);
            next.add(target.environmentId);
            return next;
          });

          // Secondary desktop-local backends (e.g. a parallel WSL backend) live
          // on their own loopback origin, so they authenticate with a bearer
          // token instead of the primary's same-origin cookie. Stash it where
          // the resolver's bearer broker looks it up.
          if (registration._tag === "BearerConnectionRegistration") {
            yield* credentials.put(registration.target.connectionId, registration.credential).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not store the platform bearer credential.", {
                  environmentId: target.environmentId,
                  error,
                }),
              ),
            );
          }

          if (persistedTarget !== undefined) {
            yield* registrations.remove(persistedTarget).pipe(
              Effect.tap(() =>
                Ref.update(persistedTargetsByEnvironment, (current) => {
                  const next = new Map(current);
                  next.delete(target.environmentId);
                  return next;
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not remove a persisted registration shadowed by a platform environment.",
                  {
                    environmentId: target.environmentId,
                    error,
                  },
                ),
              ),
            );
          }

          yield* installEntryLocked(entry, { retainEquivalentRuntime: true });
        }),
      );
    },
  );

  // Tear down a platform-managed environment that the host no longer reports
  // (e.g. the user turned the parallel WSL backend off). Platform environments
  // bypass the user-facing `remove` guard since they are reconciled from the
  // bootstrap rather than removed by hand.
  const removePlatformEnvironment = Effect.fn("EnvironmentRegistry.removePlatformEnvironment")(
    function* (environmentId: EnvironmentId) {
      yield* withLeaseLock(
        environmentId,
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
          const revoked = yield* githubRoutingPermissions.forget(environmentId).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Could not clear GitHub routing permission after platform removal.",
                {
                  environmentId,
                  error,
                },
              ),
            ),
            Effect.exit,
          );
          if (Exit.isFailure(revoked)) return;
          yield* Ref.update(platformEnvironmentIds, (current) => {
            const next = new Set(current);
            next.delete(environmentId);
            return next;
          });
          yield* closeServiceScope(environmentId);
          yield* SubscriptionRef.update(entries, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          });
          if (entry !== undefined && entry.target._tag === "BearerConnectionTarget") {
            yield* credentials.remove(entry.target.connectionId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not clear the platform bearer credential.", {
                  environmentId,
                  error,
                }),
              ),
            );
          }
          yield* Effect.all(
            [
              cache.clear(environmentId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not clear cached environment data after removal.", {
                    environmentId,
                    error,
                  }),
                ),
              ),
              ownedDataCleanup.clear(environmentId),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }),
      );
    },
  );

  const registerPlatform = Effect.fn("EnvironmentRegistry.registerPlatform")(function* (
    registration: PrimaryConnectionRegistration,
  ) {
    yield* installPlatformRegistration(registration);
  });

  // Reconcile the full set of platform-managed environments against what the
  // host currently reports: add/refresh the desired ones and tear down any
  // platform environment that disappeared (WSL toggled off, distro switched).
  const reconcilePlatform = Effect.fn("EnvironmentRegistry.reconcilePlatform")(function* (
    platformRegistrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) {
    const desiredIds = new Set(
      platformRegistrations.map((registration) => registration.target.environmentId),
    );
    const currentPlatformIds = yield* Ref.get(platformEnvironmentIds);
    yield* Effect.forEach(
      currentPlatformIds,
      (environmentId) =>
        desiredIds.has(environmentId) ? Effect.void : removePlatformEnvironment(environmentId),
      { discard: true },
    );
    yield* Effect.forEach(platformRegistrations, installPlatformRegistration, { discard: true });
  });

  const forgetEntry = Effect.fn("EnvironmentRegistry.forgetEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return yield* new PlatformEnvironmentRemovalError({
            environmentId,
          });
        }
        const target = (yield* getEntry(environmentId)).target;
        const profile =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();

        yield* githubRoutingPermissions.forget(environmentId);
        yield* registrations.remove(target);
        yield* Ref.update(persistedTargetsByEnvironment, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* closeServiceScope(environmentId);
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        // Its chat, or a host's chats, are asked for afresh if it comes back.
        yield* SubscriptionRef.update(
          hostChats,
          (held) =>
            new Map(
              [...held].filter(
                ([boxId, chat]) => boxId !== environmentId && chat.managerId !== environmentId,
              ),
            ),
        );
        yield* Effect.all(
          [
            cache.clear(environmentId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not clear cached environment data after removal.", {
                  environmentId,
                  error,
                }),
              ),
            ),
            ownedDataCleanup.clear(environmentId),
          ],
          { concurrency: "unbounded", discard: true },
        );

        if (
          target._tag === "SshConnectionTarget" &&
          Option.isSome(profile) &&
          isSshConnectionProfile(profile.value)
        ) {
          yield* ssh.disconnect(profile.value.target).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not disconnect the managed SSH environment.", {
                environmentId,
                error,
              }),
            ),
            Effect.ignore,
          );
        }
      }),
    );
  });

  const remove = Effect.fn("EnvironmentRegistry.remove")(function* (environmentId: EnvironmentId) {
    yield* forgetEntry(environmentId);
    // A host's unpaired boxes exist on this device only because it listed them, so they go too.
    for (const entry of (yield* SubscriptionRef.get(entries)).values()) {
      if (!isUnpairedBox(entry) || connectionBox(entry.target)?.managerId !== environmentId)
        continue;
      yield* forgetEntry(entry.target.environmentId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not forget a removed host's unpaired box.", {
            environmentId: entry.target.environmentId,
            error,
          }),
        ),
      );
    }
  });

  const adoptBox = Effect.fn("EnvironmentRegistry.adoptBox")(function* (
    target: BearerConnectionTarget,
    chat: ProvisionedChat | null,
  ) {
    yield* withLeaseLock(
      target.environmentId,
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(entries)).has(target.environmentId)) return;
        // Seeded before the entry exists, so the shell its chat lists from starts with the chat.
        if (chat !== null) yield* cache.saveShell(target.environmentId, chatShellSnapshot(chat));
        yield* registrations.register(new BoxTargetRegistration({ target }));
        yield* Ref.update(persistedTargetsByEnvironment, (persisted) =>
          new Map(persisted).set(target.environmentId, target),
        );
        yield* installEntryLocked({ target, profile: Option.none(), enabled: true });
      }),
    );
  });

  const relabelBox = Effect.fn("EnvironmentRegistry.relabelBox")(function* (
    environmentId: EnvironmentId,
    label: string,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (
          entry === undefined ||
          entry.target._tag !== "BearerConnectionTarget" ||
          entry.target.box === undefined ||
          entry.target.label === label
        )
          return;
        const target = new BearerConnectionTarget({ ...entry.target, label });
        yield* registrations.register(new BoxTargetRegistration({ target }));
        yield* Ref.update(persistedTargetsByEnvironment, (persisted) =>
          new Map(persisted).set(environmentId, target),
        );
        yield* replaceEntryInPlace(environmentId, { ...entry, target });
      }),
    );
  });

  const applyHostBoxStep = (
    step: HostBoxSyncStep,
  ): Effect.Effect<
    void,
    | Persistence.ConnectionPersistenceError
    | ConnectionAttemptError
    | EnvironmentNotRegisteredError
    | PlatformEnvironmentRemovalError
  > => {
    switch (step._tag) {
      case "Adopt":
        return adoptBox(step.target, step.chat);
      case "Relabel":
        return relabelBox(step.environmentId, step.label);
      case "Reseed":
        return cache.saveShell(step.environmentId, chatShellSnapshot(step.chat));
      case "MarkBox":
        return rewriteBearerTarget(step.environmentId, (target) =>
          target.box?.managerId === step.box.managerId
            ? null
            : new BearerConnectionTarget({ ...target, box: step.box, label: step.label }),
        );
      case "MarkMissing":
        return markWorkspaceMissing(step.environmentId);
      case "Forget":
        return forgetEntry(step.environmentId);
    }
  };

  const syncHostBoxes: EnvironmentRegistry["Service"]["syncHostBoxes"] = (managerId, boxes) =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(entries);
      const chats = boxes.flatMap((box) =>
        box.managerId === managerId && box.chat !== null
          ? [{ environmentId: box.environmentId, chat: box.chat }]
          : [],
      );
      const cachedSequences = new Map<EnvironmentId, number>();
      for (const { environmentId } of chats) {
        if (!current.has(environmentId)) continue;
        const cached = yield* cache
          .loadShell(environmentId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationShellSnapshot>()));
        if (Option.isSome(cached))
          cachedSequences.set(environmentId, cached.value.snapshotSequence);
      }
      const connected = new Set<EnvironmentId>();
      for (const [environmentId, lease] of yield* SubscriptionRef.get(serviceScopes)) {
        if ((yield* SubscriptionRef.get(lease.supervisor.state)).phase === "connected")
          connected.add(environmentId);
      }
      if (chats.length > 0)
        yield* SubscriptionRef.update(hostChats, (held) => {
          const next = new Map(held);
          for (const { environmentId, chat } of chats)
            next.set(environmentId, { managerId, shell: chatShellSnapshot(chat) });
          return next;
        });
      const steps = planHostBoxSync({
        managerId,
        entries: current,
        boxes,
        cachedSequences,
        connected,
      });
      for (const step of steps) {
        const environmentId =
          step._tag === "Adopt" ? step.target.environmentId : step.environmentId;
        yield* applyHostBoxStep(step).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not follow a cloud host's list of its boxes.", {
              environmentId,
              step: step._tag,
              error,
            }).pipe(
              // Asked for again on the next list, so a chat that failed to land is not lost.
              Effect.andThen(
                SubscriptionRef.update(hostChats, (held) => {
                  const next = new Map(held);
                  next.delete(environmentId);
                  return next;
                }),
              ),
            ),
          ),
        );
      }
    }).pipe(Effect.withSpan("EnvironmentRegistry.syncHostBoxes"));

  const removeRelayEnvironments = Effect.fn("EnvironmentRegistry.removeRelayEnvironments")(
    function* () {
      const relayEnvironmentIds = [...(yield* SubscriptionRef.get(entries)).values()]
        .filter((entry) => entry.target._tag === "RelayConnectionTarget")
        .map((entry) => entry.target.environmentId);

      yield* Effect.forEach(
        relayEnvironmentIds,
        (environmentId) =>
          remove(environmentId).pipe(
            Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
          ),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    },
  );

  const retryNow = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
      Effect.withSpan("EnvironmentRegistry.retryNow"),
    );
  const setEnabled = Effect.fn("EnvironmentRegistry.setEnabled")(function* (
    environmentId: EnvironmentId,
    enabled: boolean,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* getEntry(environmentId);
        if (enabled && entry.unsupportedReason !== undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: entry.unsupportedReason,
          });
        }
        if (entry.enabled === enabled) {
          return;
        }
        // Platform-managed environments are reconciled from the host and are
        // never persisted, so only user-saved ones write the flag.
        if (!(yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          yield* registrations.setEnabled(environmentId, enabled);
        }
        const next: ConnectionCatalogEntry = { ...entry, enabled };
        const lease = yield* replaceEntryInPlace(environmentId, next);
        if (lease !== undefined) {
          yield* (yield* wantsConnection(next))
            ? lease.supervisor.connect
            : lease.supervisor.disconnect;
        } else if (enabled) {
          yield* createServiceScope(next);
        }
        // The supervisor only owns the RPC session. A managed SSH backend and
        // its tunnel outlive it, so switching off tears those down as well.
        if (
          !enabled &&
          entry.target._tag === "SshConnectionTarget" &&
          Option.isSome(entry.profile) &&
          isSshConnectionProfile(entry.profile.value)
        ) {
          yield* ssh.disconnect(entry.profile.value.target).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not disconnect the switched-off SSH environment.", {
                environmentId,
                error,
              }),
            ),
            Effect.ignore,
          );
        }
      }),
    );
  });

  const state = Effect.fn("EnvironmentRegistry.state")(function* (environmentId: EnvironmentId) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* SubscriptionRef.get(supervisor.state);
  });
  const stateChanges = (environmentId: EnvironmentId) =>
    followStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(serviceScopes).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (lease) => Scope.close(lease.scope, Exit.void), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  yield* connectivity.changes.pipe(
    Stream.runForEach((status) => SubscriptionRef.set(networkStatus, status)),
    Effect.forkScoped,
  );

  const setCompatibility = Effect.fn("EnvironmentRegistry.setCompatibility")(function* (
    environmentId: EnvironmentId,
    error: ConnectionBlockedError | null,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (entry === undefined || entry.unsupportedReason === (error?.message ?? undefined))
          return;
        const { unsupportedReason: _previousReason, ...rest } = entry;
        const next: ConnectionCatalogEntry =
          error === null ? rest : { ...rest, enabled: false, unsupportedReason: error.message };
        if (
          error !== null &&
          entry.enabled &&
          !(yield* Ref.get(platformEnvironmentIds)).has(environmentId)
        ) {
          yield* registrations.setEnabled(environmentId, false);
        }
        const lease = yield* replaceEntryInPlace(environmentId, next);
        if (lease !== undefined && error !== null) yield* lease.supervisor.disconnect;
      }),
    );
  });

  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    start,
    register,
    registerPlatform,
    reconcilePlatform,
    remove,
    removeRelayEnvironments,
    retryNow,
    demand,
    demanded,
    markBoxes,
    unmarkBox,
    markWorkspaceMissing,
    syncHostBoxes,
    hostChats,
    setEnabled,
    setCompatibility,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make);
