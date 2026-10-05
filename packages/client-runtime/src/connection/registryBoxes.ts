import {
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ProvisionedChat,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ProvisionedBox } from "../cloud/provisioning.ts";
import type * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRpc from "../rpc/client.ts";
import { type BoxPairingPorts, PairingRedemption, pairBoxThroughHost } from "./boxPairing.ts";
import type { BoxWakeOutcome } from "./boxWake.ts";
import {
  BearerConnectionRegistration,
  BoxTargetRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  isUnpairedBox,
} from "./catalog.ts";
import type * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import { credentialMissingError, profileMissingError, workspaceMissingError } from "./errors.ts";
import {
  type HostBoxSyncStep,
  type HostChat,
  chatShellSnapshot,
  planHostBoxSync,
  withHostChat,
} from "./hostBoxSync.ts";
import {
  BearerConnectionTarget,
  type BoxAttachment,
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
  connectionBox,
  type PersistedConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import { UserPresence } from "./presence.ts";
import type {
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  EnvironmentServiceScope,
  PlatformEnvironmentRemovalError,
} from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";

/** Under a third of the host's 15-minute lease, so one missed beat never lets it lapse. */
const BOX_LEASE_HEARTBEAT_INTERVAL = "4 minutes";
/** Past a host's 15-second connection attempt. */
const HOST_SETTLE_TIMEOUT = "20 seconds";

/** What the environment registry offers for cloud boxes and the hosts that provision them. */
export interface BoxRegistryMethods {
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
    Persistence.ConnectionPersistenceError | ConnectionAttemptError | EnvironmentNotRegisteredError
  >;
  readonly markWorkspaceMissing: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<
    void,
    Persistence.ConnectionPersistenceError | ConnectionAttemptError | EnvironmentNotRegisteredError
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
}

/** The registry's own state and steps the box code works through. */
export interface RegistryInternals {
  readonly registryScope: Scope.Scope;
  readonly entries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly serviceScopes: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, EnvironmentServiceScope>
  >;
  readonly platformEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>;
  readonly persistedEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>;
  /** The targets `registrations` saves for an entry, its preferred route first. */
  readonly persistedRoutes: (
    entry: ConnectionCatalogEntry,
  ) => ReadonlyArray<PersistedConnectionTarget>;
  readonly registrations: Persistence.ConnectionRegistrationStore["Service"];
  readonly credentials: ConnectionCredentialStore.ConnectionCredentialStore["Service"];
  readonly cache: Persistence.EnvironmentCacheStore["Service"];
  readonly driver: ConnectionDriver.ConnectionDriver["Service"];
  readonly withLeaseLock: <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly getEntry: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<ConnectionCatalogEntry, EnvironmentNotRegisteredError>;
  /** Replaces an entry and its runtime. Run under the entry's lease lock. */
  readonly installEntryLocked: (entry: ConnectionCatalogEntry) => Effect.Effect<void>;
  readonly createServiceScope: (entry: ConnectionCatalogEntry) => Effect.Effect<unknown>;
  /** Forgets a saved environment. Run under the entry's lease lock. */
  readonly removeLocked: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<
    void,
    | Persistence.ConnectionPersistenceError
    | ConnectionAttemptError
    | EnvironmentNotRegisteredError
    | PlatformEnvironmentRemovalError
  >;
  readonly removeRoute: EnvironmentRegistry["Service"]["removeRoute"];
  readonly run: EnvironmentRegistry["Service"]["run"];
}

/**
 * The registration to save when `requested` pairs an environment again. A box stays a box however
 * it is paired again, and a pairing names a box for itself (`e2b.local`), so the saved name its
 * host gave it stays.
 */
export function keepBoxIdentity(
  previous: ConnectionCatalogEntry | undefined,
  requested: ConnectionRegistration,
): ConnectionRegistration {
  const previousBox = previous === undefined ? null : connectionBox(previous.target);
  return previous !== undefined &&
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
}

/**
 * The registry's cloud box behavior: demand, wake, lease keep-alive, pairing through the host,
 * and the chats a host lists.
 */
export const makeRegistryBoxes = Effect.fn("EnvironmentRegistry.makeRegistryBoxes")(function* (
  internals: RegistryInternals,
) {
  const {
    registryScope,
    entries,
    serviceScopes,
    platformEnvironmentIds,
    persistedEnvironmentIds,
    persistedRoutes,
    registrations,
    credentials,
    cache,
    driver: dialer,
    withLeaseLock,
    getEntry,
    installEntryLocked,
    createServiceScope,
    removeLocked,
    removeRoute: removeRouteEntry,
    run,
  } = internals;
  // A saved connection whose workspace is gone is not dialed again until it is paired anew.
  const driver = ConnectionDriver.ConnectionDriver.of({
    ...dialer,
    connect: (entry, reportProgress) =>
      entry.target._tag === "BearerConnectionTarget" && entry.target.workspaceStatus === "missing"
        ? Effect.fail(workspaceMissingError())
        : dialer.connect(entry, reportProgress),
  });
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
  const demandCounts = yield* Ref.make<ReadonlyMap<EnvironmentId, number>>(new Map());
  const demanded = yield* SubscriptionRef.make<ReadonlySet<EnvironmentId>>(new Set());
  const hostChats = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, HostChat>>(new Map());

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

  const wakeRetryLater = (detail: string): BoxWakeOutcome => ({
    _tag: "RetryLater",
    error: new ConnectionTransientError({ reason: "not-serving", detail }),
  });
  const wakeUndelivered = (detail: string): BoxWakeOutcome => ({
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
  ): Effect.Effect<BoxWakeOutcome> =>
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
        Effect.succeed<BoxWakeOutcome>({
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

  const retryBoxes = Effect.fnUntraced(function* (
    shouldRetry: (
      box: { readonly managerId: EnvironmentId },
      state: SupervisorConnectionState,
    ) => boolean,
  ) {
    for (const lease of (yield* SubscriptionRef.get(serviceScopes)).values()) {
      const box = connectionBox(lease.entry.target);
      if (box === null) continue;
      if (shouldRetry(box, yield* SubscriptionRef.get(lease.supervisor.state)))
        yield* lease.supervisor.retryNow;
    }
  });

  // A user coming back retries each box that is down at once, waking it without the wait a box
  // left alone backs off to. A wake in flight is left to finish; a retry would start it over.
  yield* userReturns.pipe(
    Effect.andThen(
      retryBoxes(
        (_, state) => state.desired && state.phase !== "connected" && state.phase !== "waking",
      ),
    ),
    Effect.forever,
    Effect.forkIn(registryScope),
  );

  // A host connecting again retries its boxes waiting out a backoff they built while it was gone.
  // A box already dialing or waking is left alone.
  yield* SubscriptionRef.changes(serviceScopes).pipe(
    Stream.map((leases) =>
      [...leases].flatMap(([managerId, lease]) =>
        connectionBox(lease.entry.target) === null
          ? [{ managerId, supervisor: lease.supervisor }]
          : [],
      ),
    ),
    Stream.changesWith(
      (left, right) =>
        left.length === right.length &&
        left.every((host, index) => host.supervisor === right[index]?.supervisor),
    ),
    Stream.switchMap((hosts) =>
      Stream.mergeAll(
        hosts.map(({ managerId, supervisor }) =>
          SubscriptionRef.changes(supervisor.state).pipe(
            Stream.map((state) => state.phase === "connected"),
            Stream.changes,
            Stream.drop(1),
            Stream.filter((connected) => connected),
            Stream.map(() => managerId),
          ),
        ),
        { concurrency: "unbounded" },
      ),
    ),
    Stream.runForEach((managerId) =>
      retryBoxes(
        (box, state) => box.managerId === managerId && state.desired && state.phase === "backoff",
      ),
    ),
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
        const next: ConnectionCatalogEntry = {
          ...current,
          target,
          profile: Option.some(registration.profile),
        };
        yield* registrations.register(
          new BearerConnectionRegistration({
            target,
            profile: registration.profile,
            credential: registration.credential,
          }),
          persistedRoutes(next),
        );
        yield* Ref.update(persistedEnvironmentIds, (persisted) =>
          new Set(persisted).add(environmentId),
        );
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
      ...driver,
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
        const next: ConnectionCatalogEntry = { ...entry, target };
        if (target.box !== undefined) {
          // A box's target is saved alone, keeping its pairing, or its lack of one.
          yield* registrations.register(
            new BoxTargetRegistration({ target }),
            persistedRoutes(next),
          );
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
            persistedRoutes(next),
          );
        }
        yield* Ref.update(persistedEnvironmentIds, (current) =>
          new Set(current).add(environmentId),
        );
        yield* installEntryLocked(next);
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

  // Removes an entry the way the registry's `remove` does, and the chats held for it as a box or a
  // host, which are asked for afresh if it comes back. Succeeds with whether it removed the entry.
  const forgetEntry = (
    environmentId: EnvironmentId,
    keep?: (entry: ConnectionCatalogEntry) => boolean,
  ) =>
    withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if (keep?.(yield* getEntry(environmentId)) === true) return;
        yield* removeLocked(environmentId);
      }),
    ).pipe(
      Effect.andThen(SubscriptionRef.get(entries)),
      Effect.map((current) => !current.has(environmentId)),
      Effect.tap((forgotten) =>
        forgotten
          ? SubscriptionRef.update(
              hostChats,
              (held) =>
                new Map(
                  [...held].filter(
                    ([boxId, chat]) => boxId !== environmentId && chat.managerId !== environmentId,
                  ),
                ),
            )
          : Effect.void,
      ),
    );

  // A host's list is read from a snapshot of the catalog, and the box's dial may pair it before
  // the list is applied. A box this device paired is its own to keep.
  const forgetUnpairedBox = (environmentId: EnvironmentId) =>
    forgetEntry(environmentId, (current) => !isUnpairedBox(current));

  // A host's unpaired boxes exist on this device only because it listed them, so they go with it.
  const forgetRemovedHostBoxes = Effect.fn("EnvironmentRegistry.forgetRemovedHostBoxes")(function* (
    managerId: EnvironmentId,
  ) {
    const current = yield* SubscriptionRef.get(entries);
    if (current.has(managerId)) return;
    for (const entry of current.values()) {
      if (!isUnpairedBox(entry) || connectionBox(entry.target)?.managerId !== managerId) continue;
      yield* forgetUnpairedBox(entry.target.environmentId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not forget a removed host's unpaired box.", {
            environmentId: entry.target.environmentId,
            error,
          }),
        ),
      );
    }
  });

  const remove = Effect.fn("EnvironmentRegistry.remove")(function* (environmentId: EnvironmentId) {
    yield* forgetEntry(environmentId);
    yield* forgetRemovedHostBoxes(environmentId);
  });

  // Removing a host's last route removes the host, and its unpaired boxes with it.
  const removeRoute = Effect.fn("EnvironmentRegistry.removeRoute")(function* (
    environmentId: EnvironmentId,
    routeId: string,
  ) {
    yield* removeRouteEntry(environmentId, routeId);
    yield* forgetRemovedHostBoxes(environmentId);
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
        yield* registrations.register(new BoxTargetRegistration({ target }), [target]);
        yield* Ref.update(persistedEnvironmentIds, (persisted) =>
          new Set(persisted).add(target.environmentId),
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
        const next: ConnectionCatalogEntry = { ...entry, target };
        yield* registrations.register(new BoxTargetRegistration({ target }), persistedRoutes(next));
        yield* Ref.update(persistedEnvironmentIds, (persisted) =>
          new Set(persisted).add(environmentId),
        );
        yield* replaceEntryInPlace(environmentId, next);
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
        return cache.loadShell(step.environmentId).pipe(
          Effect.flatMap((cached) => {
            const reseeded = withHostChat(cached, step.chat);
            return reseeded === null ? Effect.void : cache.saveShell(step.environmentId, reseeded);
          }),
        );
      case "MarkBox":
        return rewriteBearerTarget(step.environmentId, (target) =>
          target.box?.managerId === step.box.managerId
            ? null
            : new BearerConnectionTarget({ ...target, box: step.box, label: step.label }),
        );
      case "MarkMissing":
        return markWorkspaceMissing(step.environmentId);
      case "Forget":
        // A box that paired since the list was read is kept, and one its host disposed is missing.
        return forgetUnpairedBox(step.environmentId).pipe(
          Effect.flatMap((forgotten) =>
            !forgotten && step.disposed ? markWorkspaceMissing(step.environmentId) : Effect.void,
          ),
        );
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
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationV2ShellSnapshot>()));
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
          for (const { environmentId, chat } of chats) next.set(environmentId, { managerId, chat });
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

  // Re-registering an unchanged entry, or marking a box, replaces the supervisor without
  // changing the catalog, so followers track the lease itself rather than the entry.
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

  // A box's supervisor wakes it through its host and keeps its lease alive while connected. A box
  // is reached only through its host, so the addresses it reports are never saved as routes.
  const supervisorOptions = (
    entry: ConnectionCatalogEntry,
  ): EnvironmentSupervisor.EnvironmentSupervisorOptions => {
    const box = connectionBox(entry.target);
    if (box === null) return {};
    const environmentId = entry.target.environmentId;
    return {
      wake: wakeBox(environmentId, box.managerId),
      mayWake: Effect.map(
        Effect.all([userHere, hostConnected(box.managerId)]),
        ([here, connected]) => here && connected,
      ),
      keepAlive: keepBoxAlive(environmentId, box.managerId),
      learnRoutes: () => Effect.succeedNone,
    };
  };

  const driverFor = (
    entry: ConnectionCatalogEntry,
  ): ConnectionDriver.ConnectionDriver["Service"] => {
    const box = connectionBox(entry.target);
    return box === null ? driver : boxDriver(entry.target.environmentId, box.managerId);
  };

  const methods: BoxRegistryMethods = {
    demand,
    demanded,
    markBoxes,
    unmarkBox,
    markWorkspaceMissing,
    syncHostBoxes,
    hostChats,
  };

  return {
    methods,
    remove,
    removeRoute,
    wantsConnection,
    supervisorOptions,
    driverFor,
    followCurrentSupervisor,
  };
});

export type RegistryBoxes = Effect.Success<ReturnType<typeof makeRegistryBoxes>>;
