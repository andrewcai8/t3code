import {
  type DurableProvisionRequest,
  type E2bProvisionResource,
  type ProvisionAllocation,
  type ProvisionOperation,
  type ProvisionOperationState,
  type ProvisionReadiness,
  type ProvisionRequestConflict,
  type ProvisionResource,
  type ProvisionRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { retentionExpired } from "./retention.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProvisionOperationStore, type ProvisionStoreError } from "./ProvisionOperationStore.ts";

export class ProvisionProviderError extends Schema.TaggedError<ProvisionProviderError>()(
  "ProvisionProviderError",
  { message: Schema.String, retentionFailed: Schema.optional(Schema.Boolean) },
) {}

export class ProvisionProviderPorts extends Context.Service<
  ProvisionProviderPorts,
  {
    readonly create: (
      operation: ProvisionOperation,
    ) => Effect.Effect<ProvisionResource, ProvisionProviderError>;
    /** Return only resources whose operation metadata and immutable configuration match. */
    readonly recoverCreate: (
      operation: ProvisionOperation,
    ) => Effect.Effect<ReadonlyArray<ProvisionResource>, ProvisionProviderError>;
    readonly fork: (
      operation: ProvisionOperation,
      parent: E2bProvisionResource,
    ) => Effect.Effect<E2bProvisionResource, ProvisionProviderError>;
    /** Includes the parent when it still exists. The service excludes its persisted ID. */
    readonly recoverFork: (
      operation: ProvisionOperation,
      parent: E2bProvisionResource,
    ) => Effect.Effect<ReadonlyArray<E2bProvisionResource>, ProvisionProviderError>;
    /** Reconcile under the host's preparation lock, preserving its existing environment ID and work. */
    readonly prepare: (
      operation: ProvisionOperation,
      allocation: ProvisionAllocation,
    ) => Effect.Effect<ProvisionReadiness, ProvisionProviderError>;
    readonly dispose: (
      operation: ProvisionOperation,
      resource: ProvisionResource,
    ) => Effect.Effect<void, ProvisionProviderError>;
  }
>()("t3/environmentControl/Provisioning/ProvisionProviderPorts") {}

function allocatedState(
  request: DurableProvisionRequest,
  resource: ProvisionResource,
): ProvisionOperationState {
  if (request.provider !== resource.provider)
    return { kind: "failed", reason: "Provider returned a resource of another kind", resource };
  if (request.provider === "e2b" && request.strategy === "fork" && resource.provider === "e2b")
    return { kind: "parent_allocated", parent: resource };
  return { kind: "allocated", allocation: { kind: "direct", resource } };
}

export class Provisioning extends Context.Service<
  Provisioning,
  {
    readonly ensure: (
      request: DurableProvisionRequest,
    ) => Effect.Effect<ProvisionOperation, ProvisionStoreError | ProvisionRequestConflict>;
    readonly cancel: (
      requestId: ProvisionRequestId,
    ) => Effect.Effect<ProvisionOperation, ProvisionStoreError>;
  }
>()("t3/environmentControl/Provisioning") {
  static readonly make = Effect.gen(function* () {
    const store = yield* ProvisionOperationStore;
    const ports = yield* ProvisionProviderPorts;
    const save = Effect.fn("Provisioning.save")(function* (
      operation: ProvisionOperation,
      state: ProvisionOperationState,
    ) {
      return (yield* store.advance(operation, state)).operation;
    });
    const recover = Effect.fn("Provisioning.recover")(function* (
      operation: ProvisionOperation,
      allocation: Extract<ProvisionOperationState, { kind: "allocation_unknown" }>["allocation"],
    ) {
      const found = yield* (
        allocation.kind === "create"
          ? ports.recoverCreate(operation)
          : ports.recoverFork(operation, allocation.parent)
      ).pipe(Effect.result);
      if (found._tag === "Failure")
        return yield* save(operation, {
          kind: "allocation_unknown",
          allocation,
          reason: found.failure.message,
        });
      const candidates =
        allocation.kind === "fork"
          ? found.success.filter(
              (resource) =>
                resource.provider === "e2b" && resource.sandboxId !== allocation.parent.sandboxId,
            )
          : found.success;
      const resource = candidates.length === 1 ? candidates[0] : undefined;
      if (!resource)
        return yield* save(operation, {
          kind: "allocation_unknown",
          allocation,
          reason:
            candidates.length === 0
              ? "No matching resource is observable yet"
              : "More than one matching resource exists",
        });
      if (allocation.kind === "fork" && resource.provider === "e2b")
        return yield* save(operation, {
          kind: "allocated",
          allocation: { kind: "fork", parent: allocation.parent, resource },
        });
      return yield* save(operation, allocatedState(operation.request, resource));
    });
    const ensure = Effect.fn("Provisioning.ensure")(function* (request: DurableProvisionRequest) {
      let operation = yield* store.accept(request);
      for (let step = 0; step < 8; step += 1) {
        if (
          retentionExpired(request.retentionDeadline, DateTime.toEpochMillis(yield* DateTime.now))
        )
          return yield* cancel(request.requestId);
        const state = operation.state;
        switch (state.kind) {
          case "intent": {
            const issued = yield* store.advance(operation, { kind: "create_issued" });
            operation = issued.operation;
            if (!issued.changed) continue;
            const created = yield* ports.create(operation).pipe(Effect.result);
            operation = yield* save(
              operation,
              created._tag === "Success"
                ? allocatedState(operation.request, created.success)
                : {
                    kind: "allocation_unknown",
                    allocation: { kind: "create" },
                    reason: created.failure.message,
                  },
            );
            if (created._tag === "Failure")
              return created.failure.retentionFailed ? yield* cancel(request.requestId) : operation;
            break;
          }
          case "create_issued":
            operation = yield* recover(operation, { kind: "create" });
            if (operation.state.kind === "allocation_unknown") return operation;
            break;
          case "parent_allocated": {
            const issued = yield* store.advance(operation, {
              kind: "fork_issued",
              parent: state.parent,
            });
            operation = issued.operation;
            if (!issued.changed) continue;
            const forked = yield* ports.fork(operation, state.parent).pipe(Effect.result);
            operation = yield* save(
              operation,
              forked._tag === "Success"
                ? {
                    kind: "allocated",
                    allocation: { kind: "fork", parent: state.parent, resource: forked.success },
                  }
                : {
                    kind: "allocation_unknown",
                    allocation: { kind: "fork", parent: state.parent },
                    reason: forked.failure.message,
                  },
            );
            if (forked._tag === "Failure")
              return forked.failure.retentionFailed ? yield* cancel(request.requestId) : operation;
            break;
          }
          case "fork_issued":
            operation = yield* recover(operation, { kind: "fork", parent: state.parent });
            if (operation.state.kind === "allocation_unknown") return operation;
            break;
          case "allocation_unknown":
            operation = yield* recover(operation, state.allocation);
            if (operation.state.kind === "allocation_unknown") return operation;
            break;
          case "allocated":
            operation = yield* save(operation, {
              kind: "preparing",
              allocation: state.allocation,
              lastError: null,
            });
            break;
          case "preparing": {
            // A paused parent never expires, so kill it on every attempt. Dispose
            // still lists the parent, which covers a kill that fails here.
            if (state.allocation.kind === "fork")
              yield* ports
                .dispose(operation, state.allocation.parent)
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("fork parent could not be killed", { error: error.message }),
                  ),
                );
            const prepared = yield* ports.prepare(operation, state.allocation).pipe(Effect.result);
            if (
              retentionExpired(
                request.retentionDeadline,
                DateTime.toEpochMillis(yield* DateTime.now),
              ) ||
              (prepared._tag === "Failure" && prepared.failure.retentionFailed)
            )
              return yield* cancel(request.requestId);
            if (prepared._tag === "Failure")
              return yield* save(operation, {
                ...state,
                lastError: prepared.failure.message,
              });
            if (
              prepared.success.preparationHash !== operation.request.preparationHash ||
              prepared.success.sourceRevision !== operation.request.sourceRevision
            )
              return yield* save(operation, {
                ...state,
                lastError: "Prepared content does not match the immutable request",
              });
            return yield* save(operation, {
              kind: "ready",
              allocation: state.allocation,
              readiness: prepared.success,
            });
          }
          case "ready":
          case "cancel_requested":
          case "failed":
          case "disposed":
            return operation;
          default: {
            const exhaustive: never = state;
            return exhaustive;
          }
        }
      }
      return operation;
    });
    const cancel = Effect.fn("Provisioning.cancel")(function* (requestId: ProvisionRequestId) {
      let operation = yield* store.get(requestId);
      for (;;) {
        const state = operation.state;
        if (state.kind === "disposed") return operation;
        if (state.kind !== "cancel_requested") {
          let next: ProvisionOperationState;
          switch (state.kind) {
            case "intent":
              next = { kind: "disposed" };
              break;
            case "create_issued":
              next = {
                kind: "cancel_requested",
                recovery: { kind: "create" },
                resources: [],
                lastError: null,
              };
              break;
            case "parent_allocated":
              next = {
                kind: "cancel_requested",
                recovery: null,
                resources: [state.parent],
                lastError: null,
              };
              break;
            case "fork_issued":
              next = {
                kind: "cancel_requested",
                recovery: { kind: "fork", parent: state.parent },
                resources: [state.parent],
                lastError: null,
              };
              break;
            case "allocation_unknown":
              next = {
                kind: "cancel_requested",
                recovery: state.allocation,
                resources: state.allocation.kind === "fork" ? [state.allocation.parent] : [],
                lastError: null,
              };
              break;
            case "allocated":
            case "preparing":
            case "ready":
              next = {
                kind: "cancel_requested",
                recovery: null,
                resources:
                  state.allocation.kind === "fork"
                    ? [state.allocation.resource, state.allocation.parent]
                    : [state.allocation.resource],
                lastError: null,
              };
              break;
            case "failed":
              next = {
                kind: "cancel_requested",
                recovery: null,
                resources: [state.resource],
                lastError: null,
              };
              break;
          }
          operation = (yield* store.advance(operation, next)).operation;
          continue;
        }
        if (state.recovery) {
          const discovered = yield* (
            state.recovery.kind === "create"
              ? ports.recoverCreate(operation)
              : ports.recoverFork(operation, state.recovery.parent)
          ).pipe(Effect.result);
          if (discovered._tag === "Failure")
            return yield* save(operation, { ...state, lastError: discovered.failure.message });
          const recovery = state.recovery;
          const found = discovered.success;
          const resolved =
            recovery.kind === "create"
              ? found.length > 0
              : found.some(
                  (resource) =>
                    resource.provider === "e2b" && resource.sandboxId !== recovery.parent.sandboxId,
                );
          const resources = new Map(
            [...state.resources, ...found].map((resource) => [
              resource.provider === "e2b"
                ? `e2b:${resource.sandboxId}`
                : `namespace:${resource.devboxId}`,
              resource,
            ]),
          );
          const updated = yield* store.advance(operation, {
            ...state,
            resources: [...resources.values()],
            recovery: resolved ? null : recovery,
            lastError: resolved
              ? null
              : "Allocation outcome remains unknown; cleanup is not confirmed.",
          });
          operation = updated.operation;
          if (!updated.changed) continue;
        }
        if (operation.state.kind !== "cancel_requested") continue;
        const cleanup = operation.state;
        const results = yield* Effect.forEach(
          cleanup.resources,
          (resource) => ports.dispose(operation, resource).pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        const failure = results.find((result) => result._tag === "Failure");
        if (failure?._tag === "Failure")
          return yield* save(operation, { ...cleanup, lastError: failure.failure.message });
        if (cleanup.recovery) return operation;
        return yield* save(operation, { kind: "disposed" });
      }
    });
    return { ensure, cancel };
  });
  static readonly layer = Layer.effect(Provisioning, Provisioning.make);
}
