import {
  type DurableProvisionRequest,
  type E2bProvisionResource,
  type ProvisionAllocation,
  type ProvisionAllocationAttempt,
  type ProvisionOperation,
  type ProvisionOperationState,
  type ProvisionReadiness,
  type ProvisionRequestConflict,
  type ProvisionResource,
  type ProvisionRequestId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { retentionExpired } from "./retention.ts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProvisionOperationStore, type ProvisionStoreError } from "./ProvisionOperationStore.ts";
import { timeProvisionPhase } from "./provisionTiming.ts";

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
    /** Runs on the host each time a drive ends ready, whether or not its caller is still there. */
    readonly ready?: (operation: ProvisionOperation) => Effect.Effect<void>;
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

/** A create or fork call is abandoned after this, so no call outlives it. */
const ISSUE_TIMEOUT = Duration.minutes(10);
/**
 * A resource still unobservable this long after its call went out was never
 * made: the call has ended, and the provider has had time to list the result.
 */
const SETTLE_AFTER_MS = 20 * 60_000;

type PendingAllocationState = Extract<
  ProvisionOperationState,
  { kind: "create_issued" | "fork_issued" | "allocation_unknown" }
>;
const isPendingAllocation = (state: ProvisionOperationState): state is PendingAllocationState =>
  state.kind === "create_issued" ||
  state.kind === "fork_issued" ||
  state.kind === "allocation_unknown";
function pendingAttempt(state: PendingAllocationState): ProvisionAllocationAttempt {
  switch (state.kind) {
    case "create_issued":
      return { kind: "create", issuedAt: state.issuedAt };
    case "fork_issued":
      return { kind: "fork", parent: state.parent, issuedAt: state.issuedAt };
    case "allocation_unknown":
      return state.allocation;
  }
}
/** An unreadable issue time counts as long ago, so its row settles instead of waiting forever. */
function sinceIssue(attempt: ProvisionAllocationAttempt, now: number) {
  const issuedAt = Date.parse(attempt.issuedAt);
  return now - (Number.isNaN(issuedAt) ? 0 : issuedAt);
}
const settled = (attempt: ProvisionAllocationAttempt, now: number) =>
  sinceIssue(attempt, now) >= SETTLE_AFTER_MS;
/**
 * The longest an operation may go without advancing before the host ends it. It
 * outlasts the slowest single step, a 20-minute preparation plus its upload, so
 * only an operation nobody is finishing reaches it.
 */
const STALE_AFTER_MINUTES = 45;
const STALE_REASON = `Setup made no progress for ${STALE_AFTER_MINUTES} minutes, so its machine was disposed.`;
/** An unreadable update time counts as long ago, like an unreadable issue time. */
const stale = (operation: ProvisionOperation, now: number) => {
  const updatedAt = Date.parse(operation.updatedAt);
  return now - (Number.isNaN(updatedAt) ? 0 : updatedAt) >= STALE_AFTER_MINUTES * 60_000;
};
type Upkeep =
  | { readonly kind: "wait" | "cancel" | "reap" | "drive" }
  | { readonly kind: "recover"; readonly attempt: ProvisionAllocationAttempt };
/** What the host's upkeep does for one unfinished operation. */
function upkeepFor(operation: ProvisionOperation, now: number, driving: boolean): Upkeep {
  const state = operation.state;
  const expired = retentionExpired(operation.request.retentionDeadline, now);
  if (isPendingAllocation(state)) {
    // This process may still be waiting on a younger call, and recording
    // its answer must not lose to a recovery that could not yet see it.
    const attempt = pendingAttempt(state);
    if (sinceIssue(attempt, now) < Duration.toMillis(ISSUE_TIMEOUT)) return { kind: "wait" };
    return expired ? { kind: "cancel" } : { kind: "recover", attempt };
  }
  // A cleanup already running finishes on its own.
  if (state.kind === "cancel_requested") return driving ? { kind: "wait" } : { kind: "cancel" };
  if (expired) return { kind: "cancel" };
  if (stale(operation, now)) return { kind: "reap" };
  if (driving) return { kind: "wait" };
  // A recorded preparation failure waits for its caller to retry, until it goes stale.
  if (state.kind === "preparing" && state.lastError !== null) return { kind: "wait" };
  return { kind: "drive" };
}
/** A fork's recovery lists its parent too, which is never the child. */
function attemptResources(
  attempt: ProvisionAllocationAttempt,
  found: ReadonlyArray<ProvisionResource>,
): ReadonlyArray<ProvisionResource> {
  return attempt.kind === "fork"
    ? found.filter(
        (resource) =>
          resource.provider === "e2b" && resource.sandboxId !== attempt.parent.sandboxId,
      )
    : found;
}
const issue = <A>(call: Effect.Effect<A, ProvisionProviderError>) =>
  call.pipe(
    Effect.timeoutOrElse({
      duration: ISSUE_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ProvisionProviderError({
            message:
              "The provider did not answer in time; recover the allocation before proceeding",
          }),
        ),
    }),
  );

const phaseContext = (request: DurableProvisionRequest) => ({
  requestId: request.requestId,
  provider: request.provider,
});

export class Provisioning extends Context.Service<
  Provisioning,
  {
    /**
     * Accepts the request and awaits the host's drive of it. The drive is the host's,
     * not the caller's: a caller that leaves never stops it, and a repeat joins it.
     */
    readonly ensure: (
      request: DurableProvisionRequest,
    ) => Effect.Effect<ProvisionOperation, ProvisionStoreError | ProvisionRequestConflict>;
    /** Stops the request's drive, then disposes whatever it allocated. */
    readonly cancel: (
      requestId: ProvisionRequestId,
    ) => Effect.Effect<ProvisionOperation, ProvisionStoreError>;
    /**
     * Ends or resumes every operation nobody is finishing: settles a create or fork
     * whose outcome a crash lost, resumes one a restart cut off, and disposes one
     * that has made no progress for too long, recording why.
     */
    readonly reconcile: Effect.Effect<void, ProvisionStoreError>;
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
      allocation: ProvisionAllocationAttempt,
    ) {
      const found = yield* (
        allocation.kind === "create"
          ? ports.recoverCreate(operation)
          : ports.recoverFork(operation, allocation.parent)
      ).pipe(
        timeProvisionPhase("allocate.recover", phaseContext(operation.request)),
        Effect.result,
      );
      if (found._tag === "Failure")
        return yield* save(operation, {
          kind: "allocation_unknown",
          allocation,
          reason: found.failure.message,
        });
      const candidates = attemptResources(allocation, found.success);
      if (
        candidates.length === 0 &&
        settled(allocation, DateTime.toEpochMillis(yield* DateTime.now))
      )
        return yield* settleCancel(operation.request.requestId);
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
    /** Takes one request as far as it goes now. Only its driver fiber runs this. */
    const drive = Effect.fn("Provisioning.drive")(function* (request: DurableProvisionRequest) {
      let operation = yield* store.accept(request);
      const context = phaseContext(request);
      for (let step = 0; step < 8; step += 1) {
        if (
          retentionExpired(request.retentionDeadline, DateTime.toEpochMillis(yield* DateTime.now))
        )
          return yield* settleCancel(request.requestId);
        const state = operation.state;
        switch (state.kind) {
          case "intent": {
            const issuedAt = DateTime.formatIso(yield* DateTime.now);
            const issued = yield* store.advance(operation, { kind: "create_issued", issuedAt });
            operation = issued.operation;
            if (!issued.changed) continue;
            // An E2B fork request reaches create for its parent and fork for the
            // child, so the two E2B allocation costs are already separate phases.
            const created = yield* issue(ports.create(operation)).pipe(
              timeProvisionPhase("allocate.create", context),
              Effect.result,
            );
            operation = yield* save(
              operation,
              created._tag === "Success"
                ? allocatedState(operation.request, created.success)
                : {
                    kind: "allocation_unknown",
                    allocation: { kind: "create", issuedAt },
                    reason: created.failure.message,
                  },
            );
            if (created._tag === "Failure")
              return created.failure.retentionFailed
                ? yield* settleCancel(request.requestId)
                : operation;
            break;
          }
          case "parent_allocated": {
            const issuedAt = DateTime.formatIso(yield* DateTime.now);
            const issued = yield* store.advance(operation, {
              kind: "fork_issued",
              parent: state.parent,
              issuedAt,
            });
            operation = issued.operation;
            if (!issued.changed) continue;
            const forked = yield* issue(ports.fork(operation, state.parent)).pipe(
              timeProvisionPhase("allocate.fork", context),
              Effect.result,
            );
            operation = yield* save(
              operation,
              forked._tag === "Success"
                ? {
                    kind: "allocated",
                    allocation: { kind: "fork", parent: state.parent, resource: forked.success },
                  }
                : {
                    kind: "allocation_unknown",
                    allocation: { kind: "fork", parent: state.parent, issuedAt },
                    reason: forked.failure.message,
                  },
            );
            if (forked._tag === "Failure")
              return forked.failure.retentionFailed
                ? yield* settleCancel(request.requestId)
                : operation;
            break;
          }
          case "create_issued":
          case "fork_issued":
          case "allocation_unknown":
            operation = yield* recover(operation, pendingAttempt(state));
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
              yield* ports.dispose(operation, state.allocation.parent).pipe(
                timeProvisionPhase("allocate.disposeParent", context),
                Effect.catch((error) =>
                  Effect.logWarning("fork parent could not be killed", { error: error.message }),
                ),
              );
            const prepared = yield* ports
              .prepare(operation, state.allocation)
              .pipe(timeProvisionPhase("prepare", context), Effect.result);
            if (
              retentionExpired(
                request.retentionDeadline,
                DateTime.toEpochMillis(yield* DateTime.now),
              ) ||
              (prepared._tag === "Failure" && prepared.failure.retentionFailed)
            )
              return yield* settleCancel(request.requestId);
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
    const settleCancel = Effect.fn("Provisioning.settleCancel")(function* (
      requestId: ProvisionRequestId,
      reason?: string,
    ) {
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
                recovery: pendingAttempt(state),
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
                recovery: pendingAttempt(state),
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
                ...(state.kind === "ready" ? { environmentId: state.readiness.environmentId } : {}),
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
          operation = (yield* store.advance(
            operation,
            reason === undefined ? next : { ...next, reason },
          )).operation;
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
          const found = discovered.success;
          const resolved =
            attemptResources(state.recovery, found).length > 0 ||
            settled(state.recovery, DateTime.toEpochMillis(yield* DateTime.now));
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
            recovery: resolved ? null : state.recovery,
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
        return yield* save(operation, {
          kind: "disposed",
          ...(cleanup.environmentId === undefined ? {} : { environmentId: cleanup.environmentId }),
          ...(cleanup.reason === undefined ? {} : { reason: cleanup.reason }),
        });
      }
    });
    const drivers = yield* FiberMap.make<
      ProvisionRequestId,
      ProvisionOperation,
      ProvisionStoreError | ProvisionRequestConflict
    >();
    /**
     * Makes `work` the request's one fiber on this host, interrupting any fiber it
     * replaces. The fiber inherits the caller's services but not its lifetime: the
     * host's scope owns it, so a caller that leaves never stops it.
     */
    const own = (
      caller: Fiber.Fiber<unknown, unknown>,
      requestId: ProvisionRequestId,
      work: Effect.Effect<ProvisionOperation, ProvisionStoreError | ProvisionRequestConflict>,
    ) => {
      // A fork runs synchronously until it first yields, so without this yield a
      // caller resumed from inside `work` could look for the fiber before it is listed.
      const fiber = Effect.runForkWith(caller.context)(Effect.andThen(Effect.yieldNow, work));
      FiberMap.setUnsafe(drivers, requestId, fiber);
      return fiber;
    };
    /** The request's running fiber, or a new drive of it. */
    const driverOf = (request: DurableProvisionRequest) =>
      Effect.withFiberSucceed((caller) =>
        Option.getOrElse(FiberMap.getUnsafe(drivers, request.requestId), () =>
          own(
            caller,
            request.requestId,
            drive(request).pipe(
              Effect.tap((operation) =>
                operation.state.kind === "ready" && ports.ready
                  ? ports.ready(operation)
                  : Effect.void,
              ),
            ),
          ),
        ),
      );
    /**
     * Awaits the request's fiber. A fiber interrupted by its replacement, such as a
     * drive a cancel stopped, hands its caller on to that replacement.
     */
    const follow = Effect.fnUntraced(function* (
      requestId: ProvisionRequestId,
      first: Fiber.Fiber<ProvisionOperation, ProvisionStoreError | ProvisionRequestConflict>,
    ) {
      let fiber = first;
      for (;;) {
        const exit = yield* Fiber.await(fiber);
        if (!Exit.isFailure(exit) || !Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
        const next = FiberMap.getUnsafe(drivers, requestId);
        if (Option.isNone(next) || next.value === fiber) return yield* store.get(requestId);
        fiber = next.value;
      }
    });
    const ensure = Effect.fn("Provisioning.ensure")(function* (request: DurableProvisionRequest) {
      // A changed request must still be refused while its driver runs.
      yield* store.accept(request);
      return yield* follow(request.requestId, yield* driverOf(request));
    });
    /** Replaces the request's drive with its cleanup, which starts once the drive has stopped. */
    const stop = (requestId: ProvisionRequestId, reason?: string) =>
      Effect.withFiberSucceed((caller) => {
        const replaced = FiberMap.getUnsafe(drivers, requestId);
        return own(
          caller,
          requestId,
          Effect.andThen(
            Option.isSome(replaced) ? Fiber.await(replaced.value) : Effect.void,
            settleCancel(requestId, reason),
          ),
        );
      }).pipe(
        Effect.flatMap((cleanup) => follow(requestId, cleanup)),
        // Only a drive accepts a request, and a cleanup never follows into a drive.
        Effect.catchTag("ProvisionRequestConflict", Effect.die),
      );
    const cancel = (requestId: ProvisionRequestId) => stop(requestId);
    const reconcile = Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const operation of yield* store.listUnresolved) {
        const { requestId } = operation.request;
        const upkeep = upkeepFor(operation, now, FiberMap.hasUnsafe(drivers, requestId));
        if (upkeep.kind === "wait") continue;
        if (upkeep.kind === "drive") {
          yield* driverOf(operation.request);
          continue;
        }
        const settle =
          upkeep.kind === "recover"
            ? recover(operation, upkeep.attempt)
            : stop(requestId, upkeep.kind === "reap" ? STALE_REASON : undefined);
        yield* settle.pipe(
          Effect.catch((error) =>
            Effect.logWarning("provision operation could not be reconciled", {
              requestId,
              step: error.operation,
            }),
          ),
        );
      }
    }).pipe(Effect.withSpan("Provisioning.reconcile"));
    return { ensure, cancel, reconcile };
  });
  static readonly layer = Layer.effect(Provisioning, Provisioning.make);
}
