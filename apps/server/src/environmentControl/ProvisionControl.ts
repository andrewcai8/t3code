import {
  EnvironmentControlError,
  ProvisionRequestConflict,
  ProvisionRequestId,
  type EnvironmentProvisionAttachInput,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
  type EnvironmentProvisionTouchInput,
  type EnvironmentProvisionTouchResult,
  type ProvisionOperation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ProvisionRetentionError, retentionExpired } from "./retention.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProvisionRefused } from "./ProvisioningProviderProfile.ts";

const isProvisionRefused = Schema.is(ProvisionRefused);
import type { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import type { Provisioning } from "./Provisioning.ts";
import type { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";
import type { ProvisionedLeaseRegistry, RemoteAccess } from "./ProvisionedLeaseRegistry.ts";
import type { NamespaceProxyLease } from "./namespaceProxy.ts";
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
   */
  readonly touch: (operation: ProvisionOperation) => Promise<"running" | "missing">;
}
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
) {
  const activeLease = (operation: ProvisionOperation) => {
    if (operation.state.kind !== "ready") return Effect.succeed(null);
    const resource = operation.state.allocation.resource;
    return promise(() =>
      leases.register({
        leaseId: operation.request.requestId,
        ...(operation.request.retentionDeadline === undefined
          ? {}
          : { retentionDeadline: operation.request.retentionDeadline }),
        sandboxId: resource.provider === "e2b" ? resource.sandboxId : resource.devboxId,
        provider: resource.provider,
        providerInstanceId: operation.request.providerInstanceId,
        ...(resource.provider === "namespace" ? { namespaceResource: resource } : {}),
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
  return {
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
            sandboxId: resource.provider === "e2b" ? resource.sandboxId : resource.devboxId,
            providerInstanceId: operation.request.providerInstanceId,
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
            state.kind === "failed" ? state.reason : "This provisioning request was disposed.",
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
      const manifest = yield* promise(() => ports.load(input.requestId));
      const context = {
        requestId: operation.request.requestId,
        provider: operation.state.allocation.resource.provider,
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
      yield* promise(async () => {
        if (
          !(await leases.markActive({
            leaseId: lease.leaseId,
            ...(namespaceProxy ? { namespaceProxy } : {}),
            remoteAccess,
          }))
        )
          throw new Error("The lease ended while its environment was being published");
      });
      return {
        kind: "attached",
        environmentId: operation.state.readiness.environmentId,
        pairingUrl: attached.pairingUrl,
      };
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
      if ((yield* remote(operation, () => ports.touch(operation))) === "missing") {
        yield* promise(() => leases.markMissing(input.leaseId));
        return missing;
      }
      const touched = yield* promise(() => leases.touch(input.leaseId));
      return touched
        ? { kind: "touched" }
        : { kind: "refused", reason: "unknown", message: "This environment's lease has ended." };
    }),
  };
}
