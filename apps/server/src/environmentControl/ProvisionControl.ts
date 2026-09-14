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
import { ProvisionRefused } from "./driver.ts";
import type { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import type { Provisioning } from "./Provisioning.ts";
import type { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";
import type { ProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

export interface ProvisionControlPorts {
  readonly freeze: (input: EnvironmentProvisionInput) => Promise<ProvisionPreparationManifest>;
  readonly load: (id: ProvisionRequestId) => Promise<ProvisionPreparationManifest>;
  readonly attach: (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
  ) => Promise<string>;
  readonly touch: (operation: ProvisionOperation) => Promise<void>;
}
const isRequestConflict = Schema.is(ProvisionRequestConflict);
const decodeRequestId = Schema.decodeUnknownEffect(ProvisionRequestId);
const safeError = () =>
  new EnvironmentControlError({
    message: "Cloud provisioning could not be reconciled. Retry the same request.",
  });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: safeError });

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
    yield* provisioning.cancel(operation.request.requestId).pipe(Effect.mapError(safeError));
    return true;
  });
  const remote = <A>(operation: ProvisionOperation, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) => (error instanceof ProvisionRetentionError ? error : safeError()),
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error instanceof ProvisionRetentionError)
            yield* provisioning
              .cancel(operation.request.requestId)
              .pipe(Effect.mapError(safeError));
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
          error instanceof ProvisionRefused || isRequestConflict(error) ? error : safeError(),
      }).pipe(Effect.result);
      if (frozen._tag === "Failure") {
        if (isRequestConflict(frozen.failure))
          return {
            kind: "refused",
            reason: "conflict",
            message: "This request ID already names a different provisioning request.",
          };
        if (frozen.failure instanceof ProvisionRefused)
          return {
            kind: "refused",
            reason: frozen.failure.reason,
            message: frozen.failure.message,
          };
        return yield* safeError();
      }
      const operation = yield* provisioning
        .ensure(frozen.success.request)
        .pipe(Effect.mapError(safeError));
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
      const operation = yield* store.get(input.requestId).pipe(Effect.mapError(safeError));
      if ((yield* expired(operation)) || operation.state.kind !== "ready")
        return { kind: "refused", message: "This environment is not ready to attach." };
      const lease = yield* activeLease(operation);
      if (lease?.state !== "active")
        return { kind: "refused", message: "This environment's lease has ended." };
      const manifest = yield* promise(() => ports.load(input.requestId));
      return {
        kind: "attached",
        environmentId: operation.state.readiness.environmentId,
        pairingUrl: yield* remote(operation, () => ports.attach(operation, manifest)),
      };
    }),
    touch: Effect.fn("EnvironmentControl.touchProvision")(function* (
      input: EnvironmentProvisionTouchInput,
    ): Effect.fn.Return<EnvironmentProvisionTouchResult, EnvironmentControlError> {
      const id = yield* decodeRequestId(input.leaseId).pipe(Effect.mapError(safeError));
      const operation = yield* store.get(id).pipe(Effect.mapError(safeError));
      if (yield* expired(operation))
        return {
          kind: "refused",
          reason: "unknown",
          message: "This environment's retention deadline has ended.",
        };
      const lease = yield* activeLease(operation);
      if (lease?.state !== "active" || lease.owner === null)
        return {
          kind: "refused",
          reason: "unknown",
          message: "This environment has no active claimed lease.",
        };
      yield* remote(operation, () => ports.touch(operation));
      const touched = yield* promise(() => leases.touch(input.leaseId));
      return touched
        ? { kind: "touched" }
        : { kind: "refused", reason: "unknown", message: "This environment's lease has ended." };
    }),
  };
}
