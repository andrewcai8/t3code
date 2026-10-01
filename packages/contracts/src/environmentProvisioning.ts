import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentProvisionInput, ProvisionRequestId } from "./environmentControl.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const GitRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

const requestFields = {
  requestId: ProvisionRequestId,
  retentionDeadline: EnvironmentProvisionInput.fields.retentionDeadline,
  providerInstanceId: EnvironmentProvisionInput.fields.providerInstanceId,
  /**
   * The account each other driver on the machine runs, routed the same way as
   * `providerInstanceId`. Absent on requests frozen before companions were
   * recorded.
   */
  companionInstanceIds: Schema.optional(
    Schema.Array(EnvironmentProvisionInput.fields.providerInstanceId),
  ),
  agentDriver: EnvironmentProvisionInput.fields.agentDriver,
  repository: EnvironmentProvisionInput.fields.repository,
  branch: EnvironmentProvisionInput.fields.branch,
  sourceRevision: Schema.NullOr(GitRevision),
  preparationHash: Sha256,
  /**
   * Identity of the machine this request describes, ignoring anything specific
   * to the request itself. Two requests sharing it want the same disk, which is
   * what a reusable prepared parent, a snapshot, or a baked base image are each
   * a way of providing. Distinct from `preparationHash`, which also covers the
   * request id and the files this one carries and so is unique every time.
   */
  buildHash: Schema.optional(Sha256),
  chat: EnvironmentProvisionInput.fields.chat,
};
export const DurableProvisionRequest = Schema.Union([
  Schema.Struct({
    ...requestFields,
    provider: Schema.Literal("e2b"),
    templateId: TrimmedNonEmptyString,
    strategy: Schema.Literals(["direct", "fork"]),
  }),
  Schema.Struct({
    ...requestFields,
    provider: Schema.Literal("namespace"),
    /** The Namespace actor. Absent for a federated workload credential, which has none. */
    creator: Schema.optional(TrimmedNonEmptyString),
    tenantId: TrimmedNonEmptyString,
    size: TrimmedNonEmptyString,
    image: TrimmedNonEmptyString,
    region: TrimmedNonEmptyString,
    idleTimeoutMinutes: Schema.Int.check(Schema.isGreaterThan(0)),
    /**
     * The Devbox this request runs on when none is created for it: a prepared
     * spare it claimed. A Devbox cannot be renamed, so the request carries the
     * name its spare was built under. Absent, the Devbox is `t3-<requestId>`.
     */
    devboxName: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type DurableProvisionRequest = typeof DurableProvisionRequest.Type;

export const E2bProvisionResource = Schema.Struct({
  provider: Schema.Literal("e2b"),
  sandboxId: TrimmedNonEmptyString,
});
export type E2bProvisionResource = typeof E2bProvisionResource.Type;
export const ProvisionResource = Schema.Union([
  E2bProvisionResource,
  Schema.Struct({
    provider: Schema.Literal("namespace"),
    devboxId: TrimmedNonEmptyString,
    devboxName: TrimmedNonEmptyString,
    instanceId: TrimmedNonEmptyString,
    region: TrimmedNonEmptyString,
    workspaceDir: TrimmedNonEmptyString,
  }),
]);
export type ProvisionResource = typeof ProvisionResource.Type;
export const ProvisionAllocation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("direct"), resource: ProvisionResource }),
  Schema.Struct({
    kind: Schema.Literal("fork"),
    parent: E2bProvisionResource,
    resource: E2bProvisionResource,
  }),
]);
export type ProvisionAllocation = typeof ProvisionAllocation.Type;
export const ProvisionReadiness = Schema.Struct({
  environmentId: EnvironmentId,
  projectDir: TrimmedNonEmptyString,
  sourceRevision: Schema.NullOr(GitRevision),
  t3Revision: GitRevision,
  artifactSha256: Sha256,
  preparationHash: Sha256,
});
export type ProvisionReadiness = typeof ProvisionReadiness.Type;

/**
 * When a create or fork call went out. Rows written before this was recorded
 * came from a process that has since exited, so no call of theirs can still be
 * in flight and they read as issued long ago.
 */
const IssuedAt = Schema.String.pipe(
  Schema.withDecodingDefault(Effect.succeed("1970-01-01T00:00:00.000Z")),
);
/** A create or fork whose outcome is not yet recorded. */
export const ProvisionAllocationAttempt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("create"), issuedAt: IssuedAt }),
  Schema.Struct({
    kind: Schema.Literal("fork"),
    parent: E2bProvisionResource,
    issuedAt: IssuedAt,
  }),
]);
export type ProvisionAllocationAttempt = typeof ProvisionAllocationAttempt.Type;

/**
 * The environment a disposed box ran, carried from `ready` through cleanup so a client that
 * saved the box can still learn it is gone. Absent when the box never became ready, and on
 * rows disposed before it was recorded.
 */
const DisposedEnvironmentId = Schema.optional(EnvironmentId);
/** Why the host itself ended an operation nobody finished, carried from cleanup to `disposed`. */
const DisposedReason = Schema.optional(Schema.String);

export const ProvisionOperationState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cancel_requested"),
    recovery: Schema.NullOr(ProvisionAllocationAttempt),
    resources: Schema.Array(ProvisionResource),
    lastError: Schema.NullOr(Schema.String),
    environmentId: DisposedEnvironmentId,
    reason: DisposedReason,
  }),
  Schema.Struct({ kind: Schema.Literal("intent") }),
  Schema.Struct({ kind: Schema.Literal("create_issued"), issuedAt: IssuedAt }),
  Schema.Struct({ kind: Schema.Literal("parent_allocated"), parent: E2bProvisionResource }),
  Schema.Struct({
    kind: Schema.Literal("fork_issued"),
    parent: E2bProvisionResource,
    issuedAt: IssuedAt,
  }),
  Schema.Struct({
    kind: Schema.Literal("allocation_unknown"),
    allocation: ProvisionAllocationAttempt,
    reason: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("allocated"), allocation: ProvisionAllocation }),
  Schema.Struct({
    kind: Schema.Literal("preparing"),
    allocation: ProvisionAllocation,
    lastError: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    allocation: ProvisionAllocation,
    readiness: ProvisionReadiness,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: Schema.String,
    resource: ProvisionResource,
  }),
  Schema.Struct({
    kind: Schema.Literal("disposed"),
    environmentId: DisposedEnvironmentId,
    reason: DisposedReason,
  }),
]);
export type ProvisionOperationState = typeof ProvisionOperationState.Type;
export const ProvisionOperation = Schema.Struct({
  request: DurableProvisionRequest,
  requestHash: Sha256,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  state: ProvisionOperationState,
});
export type ProvisionOperation = typeof ProvisionOperation.Type;

export class ProvisionRequestConflict extends Schema.TaggedError<ProvisionRequestConflict>()(
  "ProvisionRequestConflict",
  { requestId: ProvisionRequestId },
) {}
