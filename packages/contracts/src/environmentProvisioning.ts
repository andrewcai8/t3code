import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentProvisionInput, ProvisionRequestId } from "./environmentControl.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const GitRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

const requestFields = {
  requestId: ProvisionRequestId,
  retentionDeadline: EnvironmentProvisionInput.fields.retentionDeadline,
  providerInstanceId: EnvironmentProvisionInput.fields.providerInstanceId,
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
    creator: TrimmedNonEmptyString,
    tenantId: TrimmedNonEmptyString,
    size: TrimmedNonEmptyString,
    image: TrimmedNonEmptyString,
    region: TrimmedNonEmptyString,
    idleTimeoutMinutes: Schema.Int.check(Schema.isGreaterThan(0)),
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

export const ProvisionOperationState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cancel_requested"),
    recovery: Schema.NullOr(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("create") }),
        Schema.Struct({ kind: Schema.Literal("fork"), parent: E2bProvisionResource }),
      ]),
    ),
    resources: Schema.Array(ProvisionResource),
    lastError: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("intent") }),
  Schema.Struct({ kind: Schema.Literal("create_issued") }),
  Schema.Struct({ kind: Schema.Literal("parent_allocated"), parent: E2bProvisionResource }),
  Schema.Struct({ kind: Schema.Literal("fork_issued"), parent: E2bProvisionResource }),
  Schema.Struct({
    kind: Schema.Literal("allocation_unknown"),
    allocation: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("create") }),
      Schema.Struct({ kind: Schema.Literal("fork"), parent: E2bProvisionResource }),
    ]),
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
  Schema.Struct({ kind: Schema.Literal("disposed") }),
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
