import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ComputeState = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["running", "stopped"]), observedAt: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), message: Schema.String }),
]);
export type ComputeState = typeof ComputeState.Type;
export const ManagedEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  provider: Schema.optional(Schema.Literals(["e2b", "namespace"])),
  namespaceProxy: Schema.optional(
    Schema.Struct({ proxyId: TrimmedNonEmptyString, proxyOrigin: TrimmedNonEmptyString }),
  ),
  state: ComputeState,
});
export type ManagedEnvironment = typeof ManagedEnvironment.Type;
export const EnvironmentControlList = Schema.Array(ManagedEnvironment);
export const EnvironmentControlInput = Schema.Struct({ environmentId: EnvironmentId });
export const EnvironmentControlResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("updated"), environment: ManagedEnvironment }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["busy", "unknown", "stale", "unprepared", "unsupported", "conflict"]),
    message: Schema.String,
  }),
]);
export type EnvironmentControlResult = typeof EnvironmentControlResult.Type;
export class EnvironmentControlError extends Schema.TaggedError<EnvironmentControlError>()(
  "EnvironmentControlError",
  { message: Schema.String },
) {}

/**
 * A cloud environment asked for on demand, rather than declared in advance.
 *
 * The managed environments above are long-lived machines an operator names in
 * configuration. This is the other shape: a caller picks a provider and an
 * account, and gets back a fresh environment to pair with. The two share a
 * provider vocabulary and nothing else.
 */
export const EnvironmentProvisionInput = Schema.Struct({
  provider: Schema.Literals(["e2b", "namespace"]),
  /** Provider driver selected in the local composer. */
  agentDriver: Schema.optional(ProviderDriverKind),
  /** Which provider account the environment should run its agent on. */
  providerInstanceId: TrimmedNonEmptyString,
  /** `owner/name`; omitted leaves the environment with an empty workspace. */
  repository: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
});
export type EnvironmentProvisionInput = typeof EnvironmentProvisionInput.Type;

export const ProvisionedEnvironment = Schema.Struct({
  leaseId: Schema.optional(TrimmedNonEmptyString),
  provider: Schema.optional(Schema.Literals(["e2b", "namespace"])),
  sandboxId: TrimmedNonEmptyString,
  /** Single use, and the only way a client can reach the new environment. */
  pairingUrl: TrimmedNonEmptyString,
  projectDir: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
});
export type ProvisionedEnvironment = typeof ProvisionedEnvironment.Type;

export const EnvironmentProvisionResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("provisioned"), environment: ProvisionedEnvironment }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    /**
     * `unconfigured` means this install has no provisioning template, which is
     * the ordinary state of a machine that never set cloud environments up.
     * `credentials` means the named account has none on this machine, and
     * `failed` covers a provider that accepted the request and did not finish.
     */
    reason: Schema.Literals(["unconfigured", "credentials", "unsupported", "failed"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionResult = typeof EnvironmentProvisionResult.Type;

/** A one-shot cleanup request for an environment created by provisioning. */
export const EnvironmentProvisionDisposeInput = Schema.Struct({
  leaseId: Schema.optional(TrimmedNonEmptyString),
  provider: Schema.optional(Schema.Literals(["e2b", "namespace"])),
  sandboxId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionDisposeInput = typeof EnvironmentProvisionDisposeInput.Type;

export const EnvironmentProvisionDisposeResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disposed") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["unconfigured", "unknown"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionDisposeResult = typeof EnvironmentProvisionDisposeResult.Type;

/** Pause a provisioned workspace while retaining its provider resource. */
export const EnvironmentProvisionPauseInput = Schema.Struct({
  leaseId: Schema.optional(TrimmedNonEmptyString),
  provider: Schema.optional(Schema.Literals(["e2b", "namespace"])),
  sandboxId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionPauseInput = typeof EnvironmentProvisionPauseInput.Type;

export const EnvironmentProvisionPauseResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("paused") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["unconfigured", "unknown"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionPauseResult = typeof EnvironmentProvisionPauseResult.Type;

export const EnvironmentProvisionClaimInput = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionClaimInput = typeof EnvironmentProvisionClaimInput.Type;

export const EnvironmentProvisionClaimResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("claimed") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("unknown"),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionClaimResult = typeof EnvironmentProvisionClaimResult.Type;

export const EnvironmentProvisionTouchInput = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionTouchInput = typeof EnvironmentProvisionTouchInput.Type;

export const EnvironmentProvisionTouchResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("touched") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("unknown"),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionTouchResult = typeof EnvironmentProvisionTouchResult.Type;
