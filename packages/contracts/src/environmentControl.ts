import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
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

/** Where a provisioned environment runs: an E2B Linux sandbox or a Namespace Mac. */
export const ProvisionProvider = Schema.Literals(["e2b", "namespace"]);
export type ProvisionProvider = typeof ProvisionProvider.Type;

export const ProvisionRequestId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
).pipe(Schema.brand("ProvisionRequestId"));
export type ProvisionRequestId = typeof ProvisionRequestId.Type;

/**
 * The host's last read of a box's chat: the chat's thread and its project, as the box's own shell
 * held them at `sequence`. It lets a client list a chat it has never opened without reaching the
 * box, so a paused box stays paused.
 */
export const ProvisionedChat = Schema.Struct({
  sequence: NonNegativeInt,
  project: OrchestrationProjectShell,
  thread: OrchestrationV2ThreadShell,
});
export type ProvisionedChat = typeof ProvisionedChat.Type;

/**
 * What happens to a paused cloud machine that costs money while it sleeps: it is removed at `at`,
 * after its work is backed up, or it is kept. `settled` is a settled chat's machine, removed soon
 * after it pauses; `idle` one unused for the host's cleanup days.
 */
export const ProvisionedCleanup = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scheduled"),
    at: IsoDateTime,
    reason: Schema.Literals(["settled", "idle"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("kept"),
    reason: Schema.Literals(["user", "unsaved-work"]),
  }),
]);
export type ProvisionedCleanup = typeof ProvisionedCleanup.Type;

/**
 * On a `disposed` box, until when restoring it brings it back asleep. A chat's removed box sleeps
 * this long before its host deletes it for good. Absent once it can no longer be restored.
 */
const RestorableUntil = Schema.optional(IsoDateTime).pipe(
  Schema.catchDecoding(() => Effect.succeedNone),
);

export const CloudMachineKind = Schema.Literals(["sandbox", "devbox", "mac"]);
export type CloudMachineKind = typeof CloudMachineKind.Type;

export const DiscoveredProvisionedEnvironment = Schema.Struct({
  requestId: ProvisionRequestId,
  leaseId: TrimmedNonEmptyString,
  sandboxId: TrimmedNonEmptyString,
  /**
   * `disposed` is only returned for environments a client asked about by id, and for removed
   * boxes that can still be restored.
   */
  lifecycle: Schema.Literals(["active", "paused", "missing", "disposed"]),
  environmentId: EnvironmentId,
  provider: Schema.Literals(["e2b", "namespace"]),
  /**
   * What the box runs on, which sets how long waking it takes: an E2B sandbox resumes in seconds,
   * a Namespace Devbox boots, and a Namespace Mac is restored onto a new machine. Absent from
   * hosts that predate it.
   */
  machine: Schema.optional(CloudMachineKind).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  label: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  /** Absent on a `disposed` environment whose workspace the host no longer records. */
  projectDir: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  /**
   * Only when the request asked for chats and the client does not hold this one already. A chat
   * this client cannot read, as from a newer host, is dropped rather than failing the list.
   */
  chat: Schema.optional(ProvisionedChat).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  /** Absent when the machine is never cleaned up, as one that costs nothing while paused. */
  cleanup: Schema.optional(ProvisionedCleanup).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  restorableUntil: RestorableUntil,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type DiscoveredProvisionedEnvironment = typeof DiscoveredProvisionedEnvironment.Type;
export const ProvisionedEnvironmentList = Schema.Array(DiscoveredProvisionedEnvironment);

/** Where a client dials one of its saved environments. */
export const SavedEnvironmentAddress = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: Schema.String,
});
export type SavedEnvironmentAddress = typeof SavedEnvironmentAddress.Type;

/** The first message of the chat a box is provisioned for, as that chat's first turn sends it. */
export const ProvisionFirstTurn = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  title: TrimmedNonEmptyString,
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});
export type ProvisionFirstTurn = typeof ProvisionFirstTurn.Type;

/**
 * The chat a box is provisioned for. The chat owns the box from the moment the box is ready, and
 * the host starts `firstTurn` on it whether or not a client is still connected. A message with
 * attachments or context has no `firstTurn`; the page that sent it uploads and sends it itself.
 */
export const ProvisionChat = Schema.Struct({
  threadId: ThreadId,
  firstTurn: Schema.optional(ProvisionFirstTurn),
});
export type ProvisionChat = typeof ProvisionChat.Type;

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
  /**
   * Run on `providerInstanceId` exactly. Without it the account is only a
   * tiebreak, and the driver's account with the most usage left wins.
   */
  pinAccount: Schema.optional(Schema.Boolean),
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
  chat: Schema.optional(ProvisionChat),
});
export type EnvironmentProvisionInput = typeof EnvironmentProvisionInput.Type;

/**
 * Where the host's start of a chat's first turn stands. `started` means the box took the turn
 * and the page must not send it. Anything else, including a host too old to report this, leaves
 * the first message to the page.
 */
export const ProvisionFirstTurnStatus = Schema.Literals(["pending", "started", "failed"]);
export type ProvisionFirstTurnStatus = typeof ProvisionFirstTurnStatus.Type;

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
  firstTurn: Schema.optional(ProvisionFirstTurnStatus),
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
  Schema.Struct({
    kind: Schema.Literal("refused"),
    /** `not-serving`: the box is asleep or its T3 server is down; resume it, then attach again. */
    reason: Schema.optional(Schema.Literal("not-serving")),
    message: Schema.String,
  }),
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
  Schema.Struct({ kind: Schema.Literal("disposed"), restorableUntil: RestorableUntil }),
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

/** Resume the retained workspace this manager provisioned for an environment. */
export const EnvironmentProvisionResumeInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type EnvironmentProvisionResumeInput = typeof EnvironmentProvisionResumeInput.Type;

export const EnvironmentProvisionResumeResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("resumed") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    /** `not-provisioned` means this manager holds no workspace for the environment. */
    reason: Schema.Literals(["unknown", "missing", "not-provisioned"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionResumeResult = typeof EnvironmentProvisionResumeResult.Type;

/** Move a provisioned workspace onto the manager's current pinned runtime build, in place. */
export const EnvironmentProvisionUpgradeInput = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
  sandboxId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
});
export type EnvironmentProvisionUpgradeInput = typeof EnvironmentProvisionUpgradeInput.Type;

export const EnvironmentProvisionUpgradeResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["upgraded", "current"]), t3Revision: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["unknown", "missing", "unconfigured", "busy"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionUpgradeResult = typeof EnvironmentProvisionUpgradeResult.Type;

/**
 * Move a cloud chat's machine onto another account of the provider its chat runs on, keeping the
 * conversation, machine and files. The host picks the account with the most usage left.
 */
export const EnvironmentProvisionSwitchAccountInput = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionSwitchAccountInput =
  typeof EnvironmentProvisionSwitchAccountInput.Type;

export const EnvironmentProvisionSwitchAccountResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("switched"),
    /** The account the chat runs on now, by the host's name for it. */
    account: Schema.String,
    /** Whether the chat's run that hit a usage limit was continued on the new account. */
    continued: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    /**
     * `asleep`: the machine must be awake. `no_account`: every other account is spent or unusable.
     * `unsupported`: the chat's provider, or the machine's build, cannot switch accounts.
     */
    reason: Schema.Literals(["unknown", "asleep", "busy", "no_account", "unsupported"]),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionSwitchAccountResult =
  typeof EnvironmentProvisionSwitchAccountResult.Type;

/** The drivers whose cloud accounts a host can switch. */
export const SwitchableAccountDriver = Schema.Literals(["claudeAgent", "codex"]);
export type SwitchableAccountDriver = typeof SwitchableAccountDriver.Type;

/**
 * A login a host hands one of its boxes: the provider's credential variables, or the contents of
 * the login file the driver reads from its home (Codex's `auth.json`, Claude's `.credentials.json`).
 */
export const GuestAccountCredential = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("environment"),
    variables: Schema.NonEmptyArray(
      Schema.Struct({ name: TrimmedNonEmptyString, value: TrimmedNonEmptyString }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("file"), contentsBase64: TrimmedNonEmptyString }),
]);
export type GuestAccountCredential = typeof GuestAccountCredential.Type;

/** What a host asks one of its boxes when it moves the box's driver onto another account. */
export const GuestAccountSwitchInput = Schema.Struct({
  driver: SwitchableAccountDriver,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accountEmail: Schema.optional(TrimmedNonEmptyString),
  credential: GuestAccountCredential,
  /** The chat moving accounts. Only its provider session restarts. */
  threadId: ThreadId,
  /** The chat's run that hit a usage limit, continued on the new account. */
  continueRunId: Schema.optional(RunId),
});
export type GuestAccountSwitchInput = typeof GuestAccountSwitchInput.Type;

export const GuestAccountSwitchResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("switched"), continued: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["busy", "unsupported"]),
    message: Schema.String,
  }),
]);
export type GuestAccountSwitchResult = typeof GuestAccountSwitchResult.Type;

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

/**
 * A client reports whether its user is here. While any client's user is, the host wakes the
 * machines of their unsettled cloud chats ahead of them and keeps those machines awake. A client
 * whose user is away sends `false`, which only reads the answer.
 */
export const EnvironmentControlPresenceInput = Schema.Struct({
  present: Schema.Boolean,
});
export type EnvironmentControlPresenceInput = typeof EnvironmentControlPresenceInput.Type;

/** Where a cloud machine stands before its chat can connect: asleep, waking, or being updated. */
export const CloudMachineState = Schema.Literals(["asleep", "waking", "updating"]);
export type CloudMachineState = typeof CloudMachineState.Type;

/**
 * The host's machines that are not awake right now, and what each runs on, which sets how long
 * it takes to wake. Any other box the host lists is awake.
 */
export const EnvironmentControlPresenceResult = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      state: CloudMachineState,
      machine: CloudMachineKind,
    }),
  ),
});
export type EnvironmentControlPresenceResult = typeof EnvironmentControlPresenceResult.Type;

/** Keeps a cloud machine from automatic cleanup, or allows it again. */
export const EnvironmentProvisionKeepInput = Schema.Struct({
  requestId: ProvisionRequestId,
  keep: Schema.Boolean,
});
export type EnvironmentProvisionKeepInput = typeof EnvironmentProvisionKeepInput.Type;

export const EnvironmentProvisionKeepResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("updated") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("unknown"),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionKeepResult = typeof EnvironmentProvisionKeepResult.Type;

/** Brings a removed cloud machine back, asleep, while it can still be restored. */
export const EnvironmentProvisionRestoreInput = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
});
export type EnvironmentProvisionRestoreInput = typeof EnvironmentProvisionRestoreInput.Type;

export const EnvironmentProvisionRestoreResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("restored") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("unknown"),
    message: Schema.String,
  }),
]);
export type EnvironmentProvisionRestoreResult = typeof EnvironmentProvisionRestoreResult.Type;
