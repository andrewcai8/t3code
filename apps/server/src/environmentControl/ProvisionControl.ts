import {
  EnvironmentControlError,
  ProvisionRequestConflict,
  ProvisionRequestId,
  type EnvironmentProvisionAttachInput,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionClaimInput,
  type EnvironmentProvisionClaimResult,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
  type EnvironmentProvisionTouchInput,
  type EnvironmentProvisionTouchResult,
  type EnvironmentProvisionUpgradeInput,
  type EnvironmentProvisionUpgradeResult,
  type ProvisionFirstTurn,
  type ProvisionOperation,
  provisionSandboxId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ProvisionRetentionError, retentionExpired } from "./retention.ts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ProvisionRefused } from "./ProvisioningProviderProfile.ts";

const isProvisionRefused = Schema.is(ProvisionRefused);
import type { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import type { Provisioning, ProvisionProviderPorts } from "./Provisioning.ts";
import type { ProvisionRuntimeArtifact } from "./config.ts";
import type { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";
import {
  firstTurnOverdue,
  type ProvisionedLease,
  type ProvisionedLeaseRegistry,
  type RemoteAccess,
} from "./ProvisionedLeaseRegistry.ts";
import type { NamespaceProxyLease } from "./namespaceProxy.ts";
import type { FirstTurnDelivery } from "./firstTurn.ts";
import {
  logProvisionPhases,
  timeProvisionPhase,
  type ProvisionPhase,
  type RecordProvisionPhase,
} from "./provisionTiming.ts";

export interface ProvisionControlPorts {
  readonly freeze: (input: EnvironmentProvisionInput) => Promise<ProvisionPreparationManifest>;
  readonly load: (id: ProvisionRequestId) => Promise<ProvisionPreparationManifest>;
  /**
   * Publishes the environment and mints a pairing grant. A Namespace runtime
   * serves it through a loopback proxy and hands that origin back; passing the
   * lease's recorded proxy re-binds the same origin a client already holds.
   */
  readonly attach: (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    recordedProxy?: NamespaceProxyLease,
    record?: RecordProvisionPhase,
  ) => Promise<{
    readonly pairingUrl: string;
    readonly namespaceProxy?: NamespaceProxyLease;
    readonly remoteAccess: RemoteAccess;
  }>;
  /**
   * Extends the provider's deadline and reports whether the resource is still
   * there. The runtime that owns the provider decides what "gone" looks like.
   * `released` means its machine is gone but the environment was saved and resumes.
   */
  readonly touch: (operation: ProvisionOperation) => Promise<"running" | "released" | "missing">;
  /** The build this manager currently pins for a provider, or null when none is configured. */
  readonly pinnedRuntime: (
    provider: "e2b" | "namespace",
  ) => Promise<ProvisionRuntimeArtifact | null>;
  /** Records the build a guest should run next. `prepare` then converges the guest on it. */
  readonly setRuntime: (
    id: ProvisionRequestId,
    artifact: ProvisionRuntimeArtifact,
  ) => Promise<ProvisionRuntimeArtifact>;
  readonly prepare: ProvisionProviderPorts["Service"]["prepare"];
  /** Starts a chat's first turn on its box over the box's published origin. */
  readonly deliverFirstTurn: (
    remote: RemoteAccess,
    chat: {
      readonly requestId: string;
      readonly threadId: string;
      readonly projectDir: string;
      readonly turn: ProvisionFirstTurn;
      readonly agentDriver: ProvisionOperation["request"]["agentDriver"];
    },
  ) => Promise<FirstTurnDelivery>;
  /** The chat's first message while it is still owed, or null once it is gone. */
  readonly readFirstTurn: (
    manifest: ProvisionPreparationManifest,
  ) => Promise<ProvisionFirstTurn | null>;
  /**
   * Takes the box's per-box lock, the one pause, resume and the reaper hold, and hands back its
   * release, or null while another operation holds it.
   */
  readonly holdBox?: (sandboxId: string) => Promise<(() => void) | null>;
  /** Deletes the first message once it is settled either way. */
  readonly forgetFirstTurn: (id: ProvisionRequestId) => Promise<void>;
  /** Every request whose first message is still kept. */
  readonly listFirstTurns: () => Promise<ReadonlyArray<ProvisionRequestId>>;
}
/**
 * Right after ready the host retries a box slow to answer, but only for FIRST_TURN_BUDGET: the
 * ready result waits on it, and a page that hears `pending` sends the message itself. Upkeep owns
 * every later try.
 */
const FIRST_TURN_RETRY = Schedule.spaced(Duration.seconds(1));
const FIRST_TURN_BUDGET = Duration.seconds(6);
/** States a request never leaves; a first message kept for one of them is never sent. */
const TERMINAL_STATES: ReadonlySet<ProvisionOperation["state"]["kind"]> = new Set([
  "cancel_requested",
  "failed",
  "disposed",
]);
const isRequestConflict = Schema.is(ProvisionRequestConflict);
const decodeRequestId = Schema.decodeUnknownEffect(ProvisionRequestId);
/**
 * The message crosses a trust boundary so it stays deliberately vague, but the
 * cause is attached to the instance so the host-side boundary that already logs
 * `cause` reports something usable. `Effect.mapError(safeError)` and
 * `catch: safeError` both hand it the original error, so most sites carry it
 * without changing.
 */
const safeError = () =>
  new EnvironmentControlError({
    message: "Cloud provisioning could not be reconciled. Retry the same request.",
  });
/**
 * Keeps the cause of a failure in the host log.
 *
 * The message that leaves this module stays deliberately vague because it
 * crosses a trust boundary, but every redaction below discards the cause
 * entirely, which leaves nothing to debug from — a provisioning failure becomes
 * indistinguishable from any other. This only taps, so it cannot change what a
 * caller sees or the error type it sees it as.
 */
const logCause = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tapError(effect, (cause) => Effect.logError("provisioning failed", { cause }));
/**
 * Carries a cause past a `catch` that has to keep the contract errors typed.
 *
 * Those catches must return `ProvisionRefused`, `ProvisionRequestConflict` and
 * `ProvisionRetentionError` unchanged so the narrowing below still works, which
 * leaves nowhere to log from — wrapping instead keeps the cause until a tap can
 * read it, and unwrapping restores exactly the error the callers already expect.
 */
class UnexpectedCause {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}
const reportUnexpected = <A, E, R>(effect: Effect.Effect<A, E | UnexpectedCause, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      error instanceof UnexpectedCause
        ? Effect.logError("provisioning failed", { cause: error.cause })
        : Effect.void,
    ),
    Effect.mapError((error): E | EnvironmentControlError =>
      error instanceof UnexpectedCause ? safeError() : error,
    ),
  );
const promise = <A>(run: () => Promise<A>) =>
  logCause(Effect.tryPromise({ try: run, catch: safeError }));
const missing: EnvironmentProvisionTouchResult = {
  kind: "refused",
  reason: "missing",
  message: "The provider no longer has this workspace. It cannot be reconnected.",
};

export function makeProvisionControl(
  store: ProvisionOperationStore["Service"],
  provisioning: Provisioning["Service"],
  ports: ProvisionControlPorts,
  leases: ProvisionedLeaseRegistry,
  firstTurnRetry: Schedule.Schedule<unknown> = FIRST_TURN_RETRY,
) {
  const activeLease = (operation: ProvisionOperation) => {
    const { state } = operation;
    if (state.kind !== "ready") return Effect.succeed(null);
    const resource = state.allocation.resource;
    return promise(() =>
      leases.register({
        leaseId: operation.request.requestId,
        ...(operation.request.retentionDeadline === undefined
          ? {}
          : { retentionDeadline: operation.request.retentionDeadline }),
        sandboxId: provisionSandboxId(resource),
        provider: resource.provider,
        providerInstanceId: operation.request.providerInstanceId,
        ...(operation.request.companionInstanceIds === undefined
          ? {}
          : { companionInstanceIds: operation.request.companionInstanceIds }),
        ...("devboxId" in resource ? { namespaceResource: resource } : {}),
        ...(operation.request.chat === undefined
          ? {}
          : {
              owner: {
                environmentId: state.readiness.environmentId,
                threadId: operation.request.chat.threadId,
              },
              ...(operation.request.chat.firstTurnSha256 === undefined
                ? {}
                : { firstTurnPending: true }),
            }),
      }),
    );
  };
  const expired = Effect.fn("EnvironmentControl.expired")(function* (
    operation: ProvisionOperation,
  ) {
    if (
      !retentionExpired(
        operation.request.retentionDeadline,
        DateTime.toEpochMillis(yield* DateTime.now),
      )
    )
      return false;
    yield* provisioning
      .cancel(operation.request.requestId)
      .pipe(logCause, Effect.mapError(safeError));
    return true;
  });
  /**
   * Routing counts the accounts of every saved request, so each launch saves
   * its request before the next one routes. Otherwise two launches a moment
   * apart see the same load and pick the same account.
   */
  const routing = Semaphore.makeUnsafe(1);
  /** Leases with an upgrade in flight. A second request for the same lease is refused, not queued. */
  const upgrading = new Set<string>();
  const remote = <A>(operation: ProvisionOperation, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) =>
        error instanceof ProvisionRetentionError ? error : new UnexpectedCause(error),
    }).pipe(
      reportUnexpected,
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error instanceof ProvisionRetentionError)
            yield* provisioning
              .cancel(operation.request.requestId)
              .pipe(logCause, Effect.mapError(safeError));
          return yield* safeError();
        }),
      ),
    );
  /** Publishes a ready box and records where the manager reaches it. */
  const publish = Effect.fn("EnvironmentControl.publish")(function* (
    operation: ProvisionOperation,
    lease: ProvisionedLease,
  ) {
    const manifest = yield* promise(() => ports.load(operation.request.requestId));
    const context = {
      requestId: operation.request.requestId,
      provider: operation.request.provider,
    };
    const phases: ProvisionPhase[] = [];
    const record = (phase: ProvisionPhase) => {
      phases.push(phase);
    };
    const attached = yield* remote(operation, () =>
      ports.attach(operation, manifest, lease.namespaceProxy, record),
    ).pipe(
      timeProvisionPhase("attach", context),
      Effect.ensuring(logProvisionPhases(context, phases)),
    );
    // The proxy is recorded so a resume after a manager restart can re-bind
    // the origin the paired client saved, instead of a fresh port nobody
    // knows. Remote access lets the manager ask whether the agent is working.
    const { namespaceProxy, remoteAccess } = attached;
    const published = yield* promise(async () => {
      const marked = await leases.markActive({
        leaseId: lease.leaseId,
        ...(namespaceProxy ? { namespaceProxy } : {}),
        remoteAccess,
      });
      if (!marked) throw new Error("The lease ended while its environment was being published");
      return marked;
    });
    return { ...attached, lease: published };
  });
  /**
   * Gives a ready box to the chat it was provisioned for and starts that chat's first turn, so
   * neither waits on a client. Safe to run any number of times: a turn is sent at most once, and
   * a settled one is never sent again. Answers where the first turn stands, null without one.
   */
  const settleChatOnce = (operation: ProvisionOperation) =>
    Effect.gen(function* () {
      const { state, request } = operation;
      const chat = request.chat;
      if (state.kind !== "ready" || chat === undefined) return null;
      const registered = yield* activeLease(operation);
      if (registered?.state !== "active" || registered.firstTurn === undefined)
        return registered?.firstTurn?.status ?? null;
      if (registered.firstTurn.status !== "pending") return registered.firstTurn.status;
      const { requestId } = request;
      const settle = (outcome: { status: "started" } | { status: "failed"; reason: string }) =>
        Effect.gen(function* () {
          if (outcome.status === "failed")
            yield* Effect.logError("cloud chat first turn not started", {
              requestId,
              reason: outcome.reason,
            });
          yield* promise(() => leases.settleFirstTurn(registered.leaseId, outcome));
          yield* promise(() => ports.forgetFirstTurn(requestId));
          return outcome.status;
        });
      if (firstTurnOverdue(registered, DateTime.toEpochMillis(yield* DateTime.now)))
        return yield* settle({
          status: "failed",
          reason: "The box did not take the turn in time.",
        });
      const turn = yield* promise(async () => ports.readFirstTurn(await ports.load(requestId)));
      if (turn === null)
        return yield* settle({ status: "failed", reason: "The first message was not kept." });
      const lease = registered.remoteAccess
        ? registered
        : (yield* publish(operation, registered)).lease;
      const remoteAccess = lease.remoteAccess;
      if (!remoteAccess) return "pending" as const;
      const delivery = yield* promise(() =>
        ports.deliverFirstTurn(remoteAccess, {
          requestId,
          threadId: chat.threadId,
          projectDir: state.readiness.projectDir,
          turn,
          agentDriver: request.agentDriver,
        }),
      );
      if (delivery === "pending") return "pending" as const;
      return yield* settle(
        delivery === "delivered"
          ? { status: "started" }
          : { status: "failed", reason: "The box refused the turn." },
      );
    }).pipe(Effect.catch(() => Effect.succeed("pending" as const)));
  /** Starts a chat's first turn now, retrying briefly while its box is not answering yet. */
  const settleChat = (operation: ProvisionOperation) =>
    settleChatOnce(operation).pipe(
      Effect.repeat({ schedule: firstTurnRetry, while: (status) => status === "pending" }),
      Effect.timeoutOption(FIRST_TURN_BUDGET),
      Effect.map(Option.getOrElse(() => "pending" as const)),
    );
  /**
   * Deletes every kept first message the host no longer owes: its request ended or was
   * cancelled, its box stopped or went away before taking the turn, or the turn settled where
   * the settle above did not run, such as the reaper's deadline. A turn whose box stopped first
   * is given up, so it can never start later from a message that is gone.
   */
  const forgetUnowedFirstTurns = Effect.gen(function* () {
    for (const requestId of yield* promise(() => ports.listFirstTurns())) {
      const operation = yield* store.get(requestId).pipe(Effect.option);
      const state = Option.isSome(operation) ? operation.value.state.kind : null;
      if (state !== null && state !== "ready" && !TERMINAL_STATES.has(state)) continue;
      if (state === "ready") {
        const lease = yield* promise(() => leases.findById(requestId));
        // A drive records ready just before its lease is registered. Until the lease exists
        // the turn is still owed; a box that never gets one ends disposed and is swept then.
        if (lease === null) continue;
        if (lease.firstTurn?.status === "pending") {
          if (lease.state === "active") continue;
          yield* promise(() =>
            leases.settleFirstTurn(requestId, {
              status: "failed",
              reason: "The box stopped before it took the turn.",
            }),
          );
        }
      }
      yield* promise(() => ports.forgetFirstTurn(requestId));
    }
  });
  return {
    settleChat,
    /** Retries every awake box whose chat's first turn has not started. */
    settleChats: Effect.gen(function* () {
      const waiting = (yield* promise(() => leases.awake())).filter(
        (lease) => lease.firstTurn?.status === "pending",
      );
      for (const lease of waiting) {
        const id = yield* decodeRequestId(lease.leaseId).pipe(Effect.option);
        if (Option.isNone(id)) continue;
        const operation = yield* store.get(id.value).pipe(Effect.option);
        if (Option.isSome(operation)) yield* settleChatOnce(operation.value);
      }
      yield* forgetUnowedFirstTurns;
    }).pipe(Effect.ignore),
    provision: Effect.fn("EnvironmentControl.provision")(function* (
      input: EnvironmentProvisionInput,
    ): Effect.fn.Return<EnvironmentProvisionResult, EnvironmentControlError> {
      const frozen = yield* Effect.tryPromise({
        try: () => ports.freeze(input),
        catch: (error) =>
          isProvisionRefused(error) || isRequestConflict(error)
            ? error
            : new UnexpectedCause(error),
      }).pipe(
        timeProvisionPhase("freeze", { requestId: input.requestId, provider: input.provider }),
        Effect.tap((manifest) =>
          store
            .accept(manifest.request)
            .pipe(
              Effect.catchTag("ProvisionStoreError", (cause) =>
                Effect.fail(new UnexpectedCause(cause)),
              ),
            ),
        ),
        routing.withPermits(1),
        reportUnexpected,
        Effect.result,
      );
      if (frozen._tag === "Failure") {
        if (isRequestConflict(frozen.failure))
          return {
            kind: "refused",
            reason: "conflict",
            message: "This request ID already names a different provisioning request.",
          };
        if (isProvisionRefused(frozen.failure))
          return {
            kind: "refused",
            reason: frozen.failure.reason,
            message: frozen.failure.message,
          };
        return yield* safeError();
      }
      const operation = yield* provisioning
        .ensure(frozen.success.request)
        .pipe(logCause, Effect.mapError(safeError));
      const state = operation.state;
      if (state.kind === "ready") {
        if (yield* expired(operation))
          return {
            kind: "refused",
            reason: "disposed",
            message: "This environment’s retention deadline has ended.",
          };
        const lease = yield* activeLease(operation);
        if (lease?.state !== "active")
          return {
            kind: "refused",
            reason: "disposed",
            message: "This environment's lease has ended. Start a new provisioning request.",
          };
        const manifest = frozen.success;
        const resource = state.allocation.resource;
        return {
          kind: "ready",
          requestId: input.requestId,
          environment: {
            ...state.readiness,
            leaseId: lease.leaseId,
            provider: resource.provider,
            sandboxId: provisionSandboxId(resource),
            providerInstanceId: operation.request.providerInstanceId,
            ...(lease.firstTurn === undefined ? {} : { firstTurn: lease.firstTurn.status }),
            control: {
              preparationRoot: manifest.preparation.root,
              brokerCredentialPath: `${manifest.preparation.root}/broker-token`,
              localT3Url: `http://127.0.0.1:${manifest.preparation.port}`,
              runtimeExecutable: manifest.preparation.runtimeExecutable,
              runtimeEntrypoint: `${manifest.preparation.root}/artifact/${manifest.preparation.artifact.entrypoint}`,
            },
          },
        };
      }
      if (state.kind === "failed" || state.kind === "disposed")
        return {
          kind: "refused",
          reason: state.kind,
          message:
            state.kind === "failed"
              ? state.reason
              : (state.reason ?? "This provisioning request was disposed."),
        };
      return {
        kind: state.kind === "allocation_unknown" ? "allocation_unknown" : "pending",
        requestId: input.requestId,
        message:
          state.kind === "allocation_unknown"
            ? state.reason
            : state.kind === "preparing" && state.lastError
              ? state.lastError
              : "The environment is still being prepared. Retry the same request to continue.",
      };
    }),
    attach: Effect.fn("EnvironmentControl.attach")(function* (
      input: EnvironmentProvisionAttachInput,
    ): Effect.fn.Return<EnvironmentProvisionAttachResult, EnvironmentControlError> {
      const operation = yield* store
        .get(input.requestId)
        .pipe(logCause, Effect.mapError(safeError));
      if ((yield* expired(operation)) || operation.state.kind !== "ready")
        return { kind: "refused", message: "This environment is not ready to attach." };
      const lease = yield* activeLease(operation);
      if (lease?.state !== "active")
        return { kind: "refused", message: "This environment's lease has ended." };
      const attached = yield* publish(operation, lease);
      return {
        kind: "attached",
        environmentId: operation.state.readiness.environmentId,
        pairingUrl: attached.pairingUrl,
      };
    }),
    /**
     * Records the chat that owns a box. The owner's environment must be the one the box itself
     * reported when it became ready: a client names it, and a wrong one would make the host call
     * some other machine this box.
     */
    claim: Effect.fn("EnvironmentControl.claim")(function* (
      input: EnvironmentProvisionClaimInput,
    ): Effect.fn.Return<EnvironmentProvisionClaimResult, EnvironmentControlError> {
      const refused = (message: string) =>
        ({ kind: "refused", reason: "unknown", message }) as const;
      const id = yield* decodeRequestId(input.leaseId).pipe(Effect.option);
      if (Option.isNone(id)) return refused("This lease is not a cloud box this host started.");
      const operation = yield* store.get(id.value).pipe(logCause, Effect.mapError(safeError));
      if (operation.state.kind !== "ready")
        return refused("This cloud box is not ready to be claimed.");
      if (operation.state.readiness.environmentId !== input.environmentId)
        return refused("The lease belongs to another environment.");
      const lease = yield* promise(() =>
        leases.claim({
          leaseId: input.leaseId,
          owner: { environmentId: input.environmentId, threadId: input.threadId },
        }),
      );
      return lease ? { kind: "claimed" } : refused("The cloud sandbox lease could not be claimed.");
    }),
    touch: Effect.fn("EnvironmentControl.touchProvision")(function* (
      input: EnvironmentProvisionTouchInput,
    ): Effect.fn.Return<EnvironmentProvisionTouchResult, EnvironmentControlError> {
      const id = yield* decodeRequestId(input.leaseId).pipe(logCause, Effect.mapError(safeError));
      const operation = yield* store.get(id).pipe(logCause, Effect.mapError(safeError));
      if (yield* expired(operation))
        return {
          kind: "refused",
          reason: "unknown",
          message: "This environment's retention deadline has ended.",
        };
      const lease = yield* activeLease(operation);
      if (lease?.state === "missing") return missing;
      if (lease?.state !== "active" || lease.owner === null)
        return {
          kind: "refused",
          reason: "unknown",
          message: "This environment has no active claimed lease.",
        };
      const release = ports.holdBox ? yield* promise(() => ports.holdBox!(lease.sandboxId)) : null;
      // Another operation owns the box right now; renewing the lease is all a heartbeat may do.
      if (ports.holdBox && release === null) {
        const renewed = yield* promise(() => leases.touch(input.leaseId));
        return renewed
          ? ({ kind: "touched" } as const)
          : ({
              kind: "refused",
              reason: "unknown",
              message: "This environment's lease has ended.",
            } as const);
      }
      const state = yield* remote(operation, () => ports.touch(operation)).pipe(
        Effect.ensuring(Effect.sync(() => release?.())),
      );
      if (state === "missing") {
        yield* promise(() => leases.markMissing(input.leaseId));
        return missing;
      }
      // The Mac is gone but the chat was saved: a resume brings it back on another.
      if (state === "released") {
        yield* promise(() => leases.markPaused(input.leaseId));
        return {
          kind: "refused",
          reason: "unknown",
          message: "The workspace is paused. Reconnect to continue.",
        };
      }
      const touched = yield* promise(() => leases.touch(input.leaseId));
      return touched
        ? { kind: "touched" }
        : { kind: "refused", reason: "unknown", message: "This environment's lease has ended." };
    }),
    upgrade: Effect.fn("EnvironmentControl.upgrade")(function* (
      input: EnvironmentProvisionUpgradeInput,
    ): Effect.fn.Return<EnvironmentProvisionUpgradeResult, EnvironmentControlError> {
      const unknown: EnvironmentProvisionUpgradeResult = {
        kind: "refused",
        reason: "unknown",
        message: "This workspace could not be found. Upgrade was refused.",
      };
      if (upgrading.has(input.leaseId))
        return {
          kind: "refused",
          reason: "busy",
          message: "This workspace is already being upgraded.",
        };
      upgrading.add(input.leaseId);
      return yield* Effect.gen(function* () {
        const lease = yield* promise(() => leases.findById(input.leaseId));
        if (!lease || lease.sandboxId !== input.sandboxId) return unknown;
        if (lease.state !== "active" && lease.state !== "paused")
          return {
            kind: "refused",
            reason: "missing",
            message: "This workspace is no longer available. Upgrade was refused.",
          } satisfies EnvironmentProvisionUpgradeResult;
        const id = yield* decodeRequestId(input.leaseId).pipe(logCause, Effect.mapError(safeError));
        const operation = yield* store.get(id).pipe(logCause, Effect.mapError(safeError));
        const state = operation.state;
        if (
          (yield* expired(operation)) ||
          state.kind !== "ready" ||
          state.readiness.environmentId !== input.environmentId
        )
          return unknown;
        const pinned = yield* promise(() =>
          ports.pinnedRuntime(state.allocation.resource.provider),
        );
        if (!pinned)
          return {
            kind: "refused",
            reason: "unconfigured",
            message:
              "Configure a pinned runtime artifact for this cloud platform before upgrading.",
          } satisfies EnvironmentProvisionUpgradeResult;
        if (pinned.sha256 === state.readiness.artifactSha256)
          return { kind: "current" as const, t3Revision: state.readiness.t3Revision };
        // Preparing a released instance-engine chat would open a Mac that nothing upkeeps or
        // releases; the client's resume is what brings it back.
        if ("engine" in state.allocation.resource && lease.state !== "active")
          return {
            kind: "refused",
            reason: "unknown",
            message: "Reconnect this workspace, then upgrade it.",
          } satisfies EnvironmentProvisionUpgradeResult;
        const release = ports.holdBox
          ? yield* promise(() => ports.holdBox!(lease.sandboxId))
          : null;
        if (ports.holdBox && release === null)
          return {
            kind: "refused",
            reason: "busy",
            message: "Another workspace operation is in progress. Retry shortly.",
          } satisfies EnvironmentProvisionUpgradeResult;
        return yield* Effect.gen(function* () {
          yield* promise(() => ports.setRuntime(id, pinned));
          const context = { requestId: id, provider: state.allocation.resource.provider };
          const readiness = yield* ports
            .prepare(operation, state.allocation)
            .pipe(timeProvisionPhase("upgrade", context), logCause, Effect.mapError(safeError));
          const saved = yield* store
            .advance(operation, { kind: "ready", allocation: state.allocation, readiness })
            .pipe(logCause, Effect.mapError(safeError));
          // The guest already runs the new build. Losing the write to a concurrent
          // pause or resume only means the next upgrade call re-converges and records it.
          if (!saved.changed)
            return {
              kind: "refused",
              reason: "busy",
              message: "This workspace changed while it was being upgraded. Try again.",
            } satisfies EnvironmentProvisionUpgradeResult;
          return { kind: "upgraded" as const, t3Revision: readiness.t3Revision };
        }).pipe(Effect.ensuring(Effect.sync(() => release?.())));
      }).pipe(Effect.ensuring(Effect.sync(() => upgrading.delete(input.leaseId))));
    }),
  };
}
