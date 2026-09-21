import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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

export const ProvisionRequestId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
).pipe(Schema.brand("ProvisionRequestId"));
export type ProvisionRequestId = typeof ProvisionRequestId.Type;

export const DiscoveredProvisionedEnvironment = Schema.Struct({
  requestId: ProvisionRequestId,
  leaseId: TrimmedNonEmptyString,
  sandboxId: TrimmedNonEmptyString,
  lifecycle: Schema.Literals(["active", "paused", "missing"]),
  environmentId: EnvironmentId,
  provider: Schema.Literals(["e2b", "namespace"]),
  label: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  projectDir: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type DiscoveredProvisionedEnvironment = typeof DiscoveredProvisionedEnvironment.Type;
export const ProvisionedEnvironmentList = Schema.Array(DiscoveredProvisionedEnvironment);

/**
 * A cloud environment asked for on demand, rather than declared in advance.
 *
 * The managed environments above are long-lived machines an operator names in
 * configuration. This is the other shape: a caller picks a provider and an
 * account, and gets back a fresh environment to pair with. The two share a
 * provider vocabulary and nothing else.
 */
export const EnvironmentProvisionInput = Schema.Struct({
  requestId: ProvisionRequestId,
  retentionDeadline: Schema.optional(
    IsoDateTime.check(
      Schema.makeFilter((value) => {
        const millis = Date.parse(value);
        return Number.isFinite(millis) && DateTime.formatIso(DateTime.makeUnsafe(millis)) === value;
      }),
    ),
  ),
  provider: Schema.Literals(["e2b", "namespace"]),
  /** Provider driver selected in the local composer. */
  agentDriver: Schema.optional(ProviderDriverKind),
  /** Which provider account the environment should run its agent on. */
  providerInstanceId: TrimmedNonEmptyString,
  /** `owner/name`; omitted leaves the environment with an empty workspace. */
  repository: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  sourceRevision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  workspaceFiles: Schema.optional(
    Schema.Array(
      Schema.Struct({
        destination: TrimmedNonEmptyString,
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
        contentsBase64: Schema.String,
      }),
    ).check(Schema.isMaxLength(256)),
  ),
});
export type EnvironmentProvisionInput = typeof EnvironmentProvisionInput.Type;

export const ProvisionedEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  leaseId: TrimmedNonEmptyString,
  provider: Schema.Literals(["e2b", "namespace"]),
  sandboxId: TrimmedNonEmptyString,
  projectDir: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  sourceRevision: Schema.NullOr(Schema.String),
  t3Revision: Schema.String,
  artifactSha256: Schema.String,
  control: Schema.Struct({
    preparationRoot: Schema.String,
    brokerCredentialPath: Schema.String,
    localT3Url: Schema.String,
    runtimeExecutable: Schema.String,
    runtimeEntrypoint: Schema.String,
  }),
});
export type ProvisionedEnvironment = typeof ProvisionedEnvironment.Type;

export const EnvironmentProvisionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    requestId: ProvisionRequestId,
    environment: ProvisionedEnvironment,
  }),
  Schema.Struct({
    kind: Schema.Literals(["pending", "allocation_unknown"]),
    requestId: ProvisionRequestId,
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    /**
     * `unconfigured` means this install has no provisioning template, which is
     * the ordinary state of a machine that never set cloud environments up.
     * `credentials` means the named account has none on this machine, and
     * `failed` covers a provider that accepted the request and did not finish.
     */
    reason: Schema.Literals([
      "unconfigured",
      "credentials",
      "unsupported",
      "failed",
      "conflict",
      "invalid",
      "disposed",
    ]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionResult = typeof EnvironmentProvisionResult.Type;

export const EnvironmentProvisionAttachInput = Schema.Struct({ requestId: ProvisionRequestId });
export type EnvironmentProvisionAttachInput = typeof EnvironmentProvisionAttachInput.Type;
export const EnvironmentProvisionAttachResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("attached"),
    environmentId: EnvironmentId,
    pairingUrl: TrimmedNonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("refused"), message: Schema.String }),
]);
export type EnvironmentProvisionAttachResult = typeof EnvironmentProvisionAttachResult.Type;

export const EnvironmentProvisionDisposeInput = Schema.Union([
  Schema.Struct({ requestId: ProvisionRequestId }),
  Schema.Struct({
    leaseId: Schema.optional(TrimmedNonEmptyString),
    provider: Schema.optional(Schema.Literals(["e2b", "namespace"])),
    sandboxId: TrimmedNonEmptyString,
  }),
]);
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
  Schema.Struct({ kind: Schema.Literal("missing") }),
  Schema.Struct({ kind: Schema.Literal("paused") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["unconfigured", "unknown"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionPauseResult = typeof EnvironmentProvisionPauseResult.Type;

export const EnvironmentProvisionResumeInput = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
  sandboxId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionResumeInput = typeof EnvironmentProvisionResumeInput.Type;

export const EnvironmentProvisionResumeResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("resumed") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["unknown", "missing"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionResumeResult = typeof EnvironmentProvisionResumeResult.Type;

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
    reason: Schema.Literals(["unknown", "missing"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionTouchResult = typeof EnvironmentProvisionTouchResult.Type;
