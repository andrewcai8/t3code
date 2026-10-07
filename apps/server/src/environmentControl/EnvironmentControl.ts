// @effect-diagnostics globalDate:off - provider control crosses a Promise boundary.
// @effect-diagnostics nodeBuiltinImport:off - provider control resolves state in a Node filesystem boundary.
import { ProvisionRetentionError } from "./retention.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  cloudBackupUri,
  EnvironmentControlError,
  ProviderInstanceId,
  ProvisionRequestId,
  type ComputeState,
  type EnvironmentId,
  type EnvironmentControlResult,
  type EnvironmentControlPresenceInput,
  type EnvironmentControlPresenceResult,
  type EnvironmentProvisionAttachInput,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionInput,
  type ProvisionOperation,
  type ProvisionOperationState,
  type ProvisionResource,
  type EnvironmentProvisionResult,
  type EnvironmentProvisionDisposeInput,
  type EnvironmentProvisionDisposeResult,
  type EnvironmentProvisionPauseInput,
  type EnvironmentProvisionPauseResult,
  type EnvironmentProvisionResumeInput,
  type EnvironmentProvisionResumeResult,
  type EnvironmentProvisionClaimInput,
  type EnvironmentProvisionClaimResult,
  type EnvironmentProvisionTouchInput,
  type EnvironmentProvisionTouchResult,
  type EnvironmentProvisionKeepInput,
  type EnvironmentProvisionKeepResult,
  type EnvironmentProvisionRestoreInput,
  type EnvironmentProvisionRestoreResult,
  type EnvironmentProvisionUpgradeInput,
  type EnvironmentProvisionUpgradeResult,
  type EnvironmentProvisionSwitchAccountInput,
  type EnvironmentProvisionSwitchAccountResult,
  type ManagedEnvironment,
  type DiscoveredProvisionedEnvironment,
  type SavedEnvironmentAddress,
  type ProvisionProvider,
  type ProvisionedChat,
  type ServerProvisionedSkills,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ALL_TRAFFIC } from "e2b";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderPorts, ProvisionProviderError } from "./Provisioning.ts";
import {
  configuredRuntimeArtifact,
  currentMacTemplate,
  homeFileData,
  provisionProviders,
  makeProvisionPreparationStore,
  spareKey,
  warmBaseKey,
} from "./ProvisionPreparation.ts";
import {
  makeSpareClaims,
  makeWarmBaseStore,
  makeWarmBaseUpkeep,
  selectSpare,
  selectWarmTemplate,
  settleSpare,
  warmBasePolicy,
} from "./warmBases.ts";
import { boxMachine, listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { makeProvisionControl } from "./ProvisionControl.ts";
import { deliverFirstTurn } from "./firstTurn.ts";
import { makeNamespaceAllocationPorts } from "./namespaceAllocation.ts";
import {
  makeNamespaceAccountSession,
  makeNamespaceProvisionRuntime,
} from "./NamespaceProvisionRuntime.ts";
import { makeNamespaceMacRuntime } from "./NamespaceMacRuntime.ts";
import { makeE2bAllocationPorts } from "./E2bProvisionAllocation.ts";
import { makeE2bProvisionRuntime, makeProvisionResolution } from "./E2bProvisionRuntime.ts";
import { E2bPlacementUnavailable, type E2bResumeRetry } from "./e2bResume.ts";
import { provisionFailureMessage } from "./provisionFailure.ts";
import { logProvisionPhases, type ProvisionPhase } from "./provisionTiming.ts";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { readAccountLoad } from "./accountLoad.ts";
import { readProvisionedSkills } from "./provisionedSkills.ts";
import { refreshSkillBundle } from "./skillBundleSync.ts";
import {
  credentialVariables,
  ProvisionRefused,
  resolveProvisioningProfiles,
  resolveSwitchProfile,
  type ProvisioningProviderProfile,
} from "./ProvisioningProviderProfile.ts";
import {
  makeAccountRotation,
  sendAccountSwitch,
  type AccountSwitchPorts,
  type SwitchTarget,
} from "./accountSwitch.ts";
import * as ServerConfig from "../config.ts";
import {
  readConfig,
  resolveControlConfigPath,
  type EnvironmentControlConfig,
  type ManagedTarget,
} from "./config.ts";
import { createCloudDriver, ProvisionedSandboxMissing, type CloudDriver } from "./driver.ts";
import {
  firstTurnOverdue,
  createProvisionedLeaseRegistry,
  decodeLegacyLeases,
  keepsRemovedBox,
  leaseAccounts,
  restorableUntil,
  type ProvisionedLease,
  type ProvisionedLeaseRegistry,
} from "./ProvisionedLeaseRegistry.ts";
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import {
  observeLease,
  pullLeaseUsage,
  readGuestProtocol,
  readLeaseShell,
  wakeNeedsUpgrade,
  type LeaseObservation,
} from "./leaseActivity.ts";
import { makeWakeAhead } from "./wakeAhead.ts";
import { createProvisionedChatStore, type ProvisionedChatStore } from "./provisionedChats.ts";
import { runLeaseUpkeep } from "./leaseUpkeep.ts";
import { createCleanupSweep, type CleanupCandidate } from "./cloudCleanup.ts";
import {
  repositoryIsPrivate,
  withinBudget,
  workTarget,
  type BoxBackupResult,
} from "./boxBackup.ts";
import { BoxUsageStore } from "../usage/boxUsage.ts";

const isProvisionRequestId = Schema.is(ProvisionRequestId);
/** How long a lease whose proxy could not be reconnected waits before the gateway tries again. */
const RECONNECT_RETRY_MS = 30_000;

/** The boxes an operation holds, as far as its state records them. */
function allocatedResources(state: ProvisionOperationState): ReadonlyArray<ProvisionResource> {
  switch (state.kind) {
    case "allocated":
    case "preparing":
    case "ready":
      return [state.allocation.resource];
    case "cancel_requested":
      return state.resources;
    case "failed":
      return [state.resource];
    default:
      return [];
  }
}
const isProvisionRefused = Schema.is(ProvisionRefused);

/** Boxes read at once per usage sweep, so a few stuck boxes cannot stall the rest. */
const USAGE_SYNC_CONCURRENCY = 4;
/** How long a box that showed no chat waits before a list reads it again. */
const NEW_CHAT_RETRY_MS = 60_000;

const refusalMessages = {
  busy: "Work is active. Stop was refused.",
  unknown: "The requested compute state could not be verified. Refresh and retry.",
  stale: "Host activity is stale. Stop was refused.",
  unprepared: "Persistent storage could not be flushed. Stop was refused.",
  unsupported: "The controller needs the manual Stop upgrade before this host can be stopped.",
  conflict: "Another compute command is in progress. Refresh and retry.",
};
const refused = (reason: keyof typeof refusalMessages): EnvironmentControlResult => ({
  kind: "refused",
  reason,
  message: refusalMessages[reason],
});

/**
 * Moves to a new Mac upkeep makes in a row for a chat still working at its Mac's deadline while no
 * client heartbeats or resumes it. Each costs a Mac and prompts the agent to continue, so a chat
 * that never settles is put to sleep after this many.
 */
const MAX_UNWATCHED_MOVES = 3;

/**
 * Times the reaper keeps one idle box awake to move it onto one pinned build. A box that fails
 * them sleeps on its old build, so a broken upgrade never keeps a box awake.
 */
const MAX_IDLE_UPGRADES = 2;

/**
 * Longest a pause waits for the box's backup. Generous for a push and a few session files, short
 * enough that a reaper sweep over several boxes is not held up for long.
 */
const SLEEP_BACKUP_BUDGET_MS = 45_000;
/** Past its budget a backup's own deadline has passed; this covers an SDK call that ignores it. */
const BACKUP_GRACE_MS = 10_000;

/**
 * Moving an idle box onto the pinned build before it sleeps, so its next wake is not held up.
 * `due` names the build a box would move to, or null when it is on it. `start` runs in the
 * background under the box's own lock.
 */
interface IdleUpgrade {
  readonly due: (lease: ProvisionedLease) => Promise<string | null>;
  readonly start: (lease: ProvisionedLease) => void;
}

/**
 * Moving a box whose owner's chat stopped on a usage limit onto another account. `due` says the
 * chat waits on a switch; `start` runs it in the background under the box's own lock.
 */
interface AccountRotation {
  readonly due: (lease: ProvisionedLease, chat: ProvisionedChat) => Promise<boolean>;
  readonly start: (lease: ProvisionedLease) => void;
}

/**
 * Backs a box up while it is awake: answers the lease's next backup record and what could not be
 * saved, or null for a box this host does not back up or that is not awake. Every command of it
 * ends by `deadline`, epoch ms.
 */
interface BoxBackup {
  readonly run: (lease: ProvisionedLease, deadline: number) => Promise<BoxBackupResult | null>;
  /** How long a pause waits for the backup it takes first. */
  readonly sleepBudgetMs: number;
}

/**
 * One upkeep pass for a chat on the Namespace instance engine: a periodic
 * save, or a release ahead of its Mac's deadline. `reopen` when the chat is
 * off its Mac but must not sleep, such as one still working at the deadline,
 * or on a Mac a move never finished restoring. Null for any other lease.
 */
type UpkeepChat = (input: {
  readonly sandboxId: string;
  readonly idle: () => Promise<boolean>;
}) => Promise<"kept" | "released" | "reopen" | "missing" | null>;

export function createEnvironmentControl(
  targets: ReadonlyArray<ManagedTarget>,
  driver: CloudDriver & {
    readonly upkeepChat?: UpkeepChat;
    readonly idleUpgrade?: IdleUpgrade;
    readonly accountRotation?: AccountRotation;
    readonly boxBackup?: BoxBackup;
  },
  leaseRegistry?: ProvisionedLeaseRegistry,
  observe: (lease: ProvisionedLease) => Promise<LeaseObservation> = observeLease,
  pullUsage: (lease: ProvisionedLease) => Promise<void> = async () => {},
  /** Where a failure this service retries later, rather than returns, is reported. */
  reportFailure: (
    message: string,
    fields: { readonly chatId?: string; readonly cause: unknown },
  ) => void = () => {},
  /** Where each read of a box's chat is kept, so clients can list it while the box sleeps. */
  chats?: ProvisionedChatStore,
) {
  const pending = new Map<
    EnvironmentId,
    { action: "start" | "stop"; promise: Promise<EnvironmentControlResult> }
  >();
  const leaseOperations = new Map<
    string,
    | { action: "pause" | "dispose" | "reap" | "renew" | "save" | "hold" | "clean" }
    | { action: "resume"; ownerKey: string; promise: Promise<EnvironmentProvisionResumeResult> }
  >();
  let bootstrapping: Promise<void> | undefined;
  let readingNewChats: Promise<void> | undefined;
  /** When each box was last read for a new chat, so one that never shows one is not read per list. */
  const newChatReadAt = new Map<string, number>();
  // Every read of a box's shell also keeps its chat, so the chat a paused box shows is the one it
  // held when last read: at the latest, right before its pause.
  const observeAndKeep = async (lease: ProvisionedLease) => {
    const observation = await observe(lease);
    if (observation.chat && chats)
      await chats
        .record(lease.leaseId, observation.chat)
        .catch((cause: unknown) =>
          reportFailure("cloud box chat could not be kept", { chatId: lease.leaseId, cause }),
        );
    return observation;
  };
  const activity = async (lease: ProvisionedLease) => (await observeAndKeep(lease)).activity;
  /** Whether the box's owner chat stopped on a usage limit that an account switch should take. */
  const rotationDue = async (lease: ProvisionedLease, observation: LeaseObservation) =>
    observation.chat && driver.accountRotation
      ? driver.accountRotation.due(lease, observation.chat).catch(() => false)
      : false;
  /** The last activity each awake lease settled on, so a finished turn pulls once. */
  const settledActivity = new Map<string, "busy" | "idle">();
  /** Idle upgrades started per box and build, which bounds how long upgrades keep a box awake. */
  const idleUpgrades = new Map<string, number>();
  // A stopped box's transcripts are unreachable, so its usage is pulled first.
  // A failed pull never blocks the stop.
  const pullBeforeStop = async (lease: ProvisionedLease): Promise<void> => {
    if (lease.state !== "active" || !lease.remoteAccess) return;
    await pullUsage(lease).catch(() => undefined);
  };
  /**
   * Saves a box's work and chat within `budgetMs` and records what it saved. A backup that fails
   * or runs out of time is reported, never thrown.
   */
  const backUp = async (lease: ProvisionedLease, budgetMs: number, when: string) => {
    const backup = driver.boxBackup;
    if (!backup || !leaseRegistry) return;
    try {
      const result = await withinBudget(
        backup.run(lease, Date.now() + budgetMs),
        budgetMs + Math.min(BACKUP_GRACE_MS, budgetMs),
      );
      if (result === "timeout") {
        reportFailure(`cloud box backup ${when} ran out of time`, {
          chatId: lease.leaseId,
          cause: `over ${budgetMs} ms`,
        });
        return;
      }
      if (!result) return;
      if (result.backup && result.backup !== lease.backup)
        await leaseRegistry.recordBackup(lease.leaseId, result.backup);
      if (result.problems.length > 0)
        reportFailure(`cloud box backup ${when} saved only part of its work`, {
          chatId: lease.leaseId,
          cause: result.problems.join(" "),
        });
    } catch (cause) {
      reportFailure(`cloud box could not be backed up ${when}`, { chatId: lease.leaseId, cause });
    }
  };
  // A box that sleeps may never wake (E2B has failed to place one for hours), so its work and
  // chat are saved first. A backup that fails or runs out of time never blocks the sleep.
  const backUpBeforeSleep = async (lease: ProvisionedLease): Promise<void> => {
    if (!lease.remoteAccess || lease.state !== "active") return;
    await backUp(lease, driver.boxBackup?.sleepBudgetMs ?? 0, "before sleeping");
  };
  const beforeSleep = (lease: ProvisionedLease) =>
    Promise.all([pullBeforeStop(lease), backUpBeforeSleep(lease)]);
  /** Brings a lease's machine back and records it awake: a client's resume, or a moved chat's. */
  const wake = async (
    lease: ProvisionedLease,
    environmentId: string | undefined,
    hostMove = false,
  ) => {
    const resumed = await driver.resume({
      leaseId: lease.leaseId,
      sandboxId: lease.sandboxId,
      ...(environmentId ? { environmentId } : {}),
      providerInstanceId: lease.providerInstanceId,
      ...(lease.namespaceResource ? { namespaceResource: lease.namespaceResource } : {}),
      ...(lease.namespaceProxy ? { namespaceProxy: lease.namespaceProxy } : {}),
    });
    if (!(await leaseRegistry?.markActive({ leaseId: lease.leaseId, hostMove, ...resumed })))
      throw new Error("Lease could not be resumed");
  };
  const snapshot = async (target: ManagedTarget): Promise<ManagedEnvironment> => {
    let state: ComputeState;
    try {
      state = { kind: (await driver.observe(target)).kind, observedAt: new Date().toISOString() };
    } catch {
      state = { kind: "unavailable", message: "Provider state could not be verified." };
    }
    return {
      environmentId: target.environmentId,
      label: target.label,
      provider: target.machine.provider,
      state,
    };
  };
  const execute = async (
    target: ManagedTarget,
    action: "start" | "stop",
  ): Promise<EnvironmentControlResult> => {
    const observed = await driver.observe(target);
    if (
      (action === "start" && observed.kind === "running") ||
      (action === "stop" && observed.kind === "stopped")
    )
      return { kind: "updated", environment: await snapshot(target) };
    const broker = await driver.observeBroker();
    if (action === "start") {
      if (broker.kind === "stopped") {
        bootstrapping ??= driver.bootstrapBroker().finally(() => {
          bootstrapping = undefined;
        });
        await bootstrapping;
      }
      await driver.wake(target);
    } else {
      if (broker.kind !== "running" || observed.kind !== "running") return refused("unknown");
      const result = await driver.stop(target, observed.instanceId);
      if (result.kind === "refused") return refused(result.reason);
    }
    const environment = await snapshot(target);
    if (environment.state.kind !== (action === "start" ? "running" : "stopped"))
      return refused("unknown");
    return { kind: "updated", environment };
  };
  const command = (
    environmentId: EnvironmentId,
    action: "start" | "stop",
  ): Promise<EnvironmentControlResult> => {
    const target = targets.find((candidate) => candidate.environmentId === environmentId);
    if (!target) return Promise.resolve(refused("unknown"));
    const existing = pending.get(environmentId);
    if (existing)
      return existing.action === action ? existing.promise : Promise.resolve(refused("conflict"));
    const promise = execute(target, action)
      .catch(() => refused("unknown"))
      .finally(() => pending.delete(environmentId));
    pending.set(environmentId, { action, promise });
    return promise;
  };
  const reapExpiredLeases = async (only?: ReadonlySet<string>): Promise<void> => {
    if (!leaseRegistry) return;
    const upgrades: Array<ProvisionedLease> = [];
    const rotations: Array<ProvisionedLease> = [];
    // Heartbeat expiry is a liveness transition only. Keep the provider
    // resource paused and reconnectable; disposal is explicit.
    for (const lease of await leaseRegistry.expired()) {
      if (only && !only.has(lease.leaseId)) continue;
      // Nothing has run on a box whose chat's first turn has not started, so it is not idle,
      // until that turn is overdue. Then it is given up here too, so a turn upkeep can never
      // settle cannot hold the box awake.
      if (lease.state === "active" && lease.firstTurn?.status === "pending") {
        if (!firstTurnOverdue(lease, Date.now())) continue;
        await leaseRegistry.settleFirstTurn(lease.leaseId, {
          status: "failed",
          reason: "The box did not take the turn in time.",
        });
      }
      // A resume or renew in flight is working on this box. Stopping it under
      // them kills their commands, and a resume ends by renewing the lease.
      if (leaseOperations.has(lease.sandboxId)) continue;
      leaseOperations.set(lease.sandboxId, { action: "reap" });
      try {
        // An expired heartbeat means no client is watching, not that the agent
        // stopped. Only a machine confirmed busy stays awake; one that cannot be
        // read is paused, so a broken machine is never kept alive.
        const observation = lease.state === "active" ? await observeAndKeep(lease) : null;
        const observed = observation?.activity ?? null;
        if (observed === "busy" && (await leaseRegistry.touch(lease.leaseId, undefined, "host")))
          continue;
        // A chat stopped on a usage limit moves to another account and carries on, unwatched.
        if (
          observation &&
          (await rotationDue(lease, observation)) &&
          (await leaseRegistry.touch(lease.leaseId, undefined, "host"))
        ) {
          rotations.push(lease);
          continue;
        }
        // Nothing runs on an idle box, so it moves onto the pinned build now and sleeps on a
        // later sweep, rather than holding up the wake that next opens it.
        const build = observed === "idle" ? await driver.idleUpgrade?.due(lease) : null;
        const tries = build ? (idleUpgrades.get(`${lease.leaseId}:${build}`) ?? 0) : 0;
        if (build && tries < MAX_IDLE_UPGRADES) {
          idleUpgrades.set(`${lease.leaseId}:${build}`, tries + 1);
          upgrades.push(lease);
          continue;
        }
        const release =
          lease.state === "releasing"
            ? "started"
            : await leaseRegistry.beginRelease({
                leaseId: lease.leaseId,
                sandboxId: lease.sandboxId,
              });
        if (release !== "started") continue;
        // beginRelease already moved this lease to `releasing`, so the
        // recheck confirms that and not the state it held before.
        const current = await leaseRegistry.findBySandbox(lease.sandboxId);
        if (
          !current ||
          current.state !== "releasing" ||
          current.expiresAt > new Date().toISOString()
        )
          continue;
        await beforeSleep(lease);
        const result = await driver.pause({
          sandboxId: current.sandboxId,
          ...(current.namespaceResource ? { namespaceResource: current.namespaceResource } : {}),
        });
        if (result === "missing") await leaseRegistry.markMissing(lease.leaseId);
        else await leaseRegistry.markPaused(lease.leaseId);
      } catch (cause) {
        // Keep the lease eligible for another pause attempt on the next sweep.
        reportFailure("expired cloud box could not be paused", { chatId: lease.leaseId, cause });
      } finally {
        leaseOperations.delete(lease.sandboxId);
      }
    }
    // Each upgrade and switch takes its box's lock itself, so it starts once the sweep let go.
    for (const lease of upgrades) driver.idleUpgrade?.start(lease);
    for (const lease of rotations) driver.accountRotation?.start(lease);
  };
  return {
    list: () => Promise.all(targets.map(snapshot)),
    start: (id: EnvironmentId) => command(id, "start"),
    stop: (id: EnvironmentId) => command(id, "stop"),
    dispose: async (
      input: Extract<EnvironmentProvisionDisposeInput, { sandboxId: string }>,
    ): Promise<EnvironmentProvisionDisposeResult> => {
      if (leaseOperations.has(input.sandboxId))
        return {
          kind: "refused",
          reason: "unknown",
          message: "Another workspace operation is in progress. Retry shortly.",
        };
      leaseOperations.set(input.sandboxId, { action: "dispose" });
      try {
        if (leaseRegistry) {
          const before = await leaseRegistry.findBySandbox(input.sandboxId);
          const knownMissing = before?.state === "missing";
          const release = await leaseRegistry.beginRelease(input);
          if (release === "disposed") return { kind: "disposed" };
          if (release === "missing")
            return {
              kind: "refused",
              reason: "unknown",
              message: "The cloud sandbox lease is unknown.",
            };
          if (release === "busy")
            return {
              kind: "refused",
              reason: "unknown",
              message: "Another cleanup is already in progress.",
            };
          if (release === "started") {
            const lease = await leaseRegistry.findBySandbox(input.sandboxId);
            if (before) await pullBeforeStop(before);
            try {
              await driver.dispose({
                sandboxId: input.sandboxId,
                ...(lease?.namespaceResource ? { namespaceResource: lease.namespaceResource } : {}),
                ...(lease?.namespaceProxy ? { namespaceProxy: lease.namespaceProxy } : {}),
              });
            } catch {
              // The provider already reported this resource gone, so a failed
              // cleanup leaves nothing running. Otherwise keep the lease to retry.
              if (!knownMissing)
                return {
                  kind: "refused",
                  reason: "unknown",
                  message: "The cloud sandbox could not be disposed.",
                };
            }
            if (lease) await leaseRegistry.markDisposed(lease.leaseId);
            return { kind: "disposed" };
          }
        }
        await driver.dispose({ sandboxId: input.sandboxId });
        return { kind: "disposed" };
      } catch {
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox could not be disposed.",
        };
      } finally {
        leaseOperations.delete(input.sandboxId);
      }
    },
    /**
     * Puts a chat's box to sleep and records it removed, restorable until its grace ends. Unlike
     * a pause it never waits for a working agent. A box already removed answers the same, and
     * `missing` means its provider no longer has it.
     */
    remove: async (
      leaseId: string,
    ): Promise<EnvironmentProvisionDisposeResult | { readonly kind: "missing" }> => {
      const lease = await leaseRegistry?.findById(leaseId);
      const removedUntil = lease ? restorableUntil(lease) : null;
      if (removedUntil !== null) return { kind: "disposed", restorableUntil: removedUntil };
      if (!leaseRegistry || !lease || lease.state === "disposed")
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox lease is unknown.",
        };
      if (lease.state === "missing") return { kind: "missing" };
      if (leaseOperations.has(lease.sandboxId))
        return {
          kind: "refused",
          reason: "unknown",
          message: "Another workspace operation is in progress. Retry shortly.",
        };
      leaseOperations.set(lease.sandboxId, { action: "dispose" });
      try {
        if (lease.state !== "paused") {
          await beforeSleep(lease);
          const result = await driver.pause({
            sandboxId: lease.sandboxId,
            ...(lease.namespaceResource ? { namespaceResource: lease.namespaceResource } : {}),
          });
          if (result === "missing") return { kind: "missing" };
        }
        const removed = await leaseRegistry.markRemoved(lease.leaseId);
        const until = removed ? restorableUntil(removed) : null;
        if (until !== null) return { kind: "disposed", restorableUntil: until };
      } catch (cause) {
        reportFailure("cloud box could not be removed", { chatId: leaseId, cause });
      } finally {
        leaseOperations.delete(lease.sandboxId);
      }
      return {
        kind: "refused",
        reason: "unknown",
        message: "The cloud sandbox could not be disposed.",
      };
    },
    pause: async (
      input: EnvironmentProvisionPauseInput,
    ): Promise<EnvironmentProvisionPauseResult> => {
      if (leaseOperations.has(input.sandboxId))
        return {
          kind: "refused",
          reason: "unknown",
          message: "Another workspace operation is in progress. Retry shortly.",
        };
      leaseOperations.set(input.sandboxId, { action: "pause" });
      try {
        if (!leaseRegistry)
          return {
            kind: "refused",
            reason: "unknown",
            message: "The cloud sandbox lease registry is unavailable.",
          };
        const lease = await leaseRegistry.findBySandbox(input.sandboxId);
        if (
          !lease ||
          (input.leaseId !== undefined && lease.leaseId !== input.leaseId) ||
          (lease.state !== "active" && lease.state !== "paused" && lease.state !== "missing")
        )
          return {
            kind: "refused",
            reason: "unknown",
            message: "The cloud sandbox lease is unknown.",
          };
        if (lease.state === "missing") return { kind: "missing" };
        if (lease.state === "active" && (await activity(lease)) === "busy")
          return {
            kind: "refused",
            reason: "unknown",
            message: "Another chat on this machine is still working.",
          };
        await beforeSleep(lease);
        const result = await driver.pause({
          sandboxId: input.sandboxId,
          ...(lease.namespaceResource ? { namespaceResource: lease.namespaceResource } : {}),
        });
        if (result === "missing") {
          await leaseRegistry.markMissing(lease.leaseId);
          return { kind: "missing" };
        }
        await leaseRegistry.markPaused(lease.leaseId);
        return { kind: "paused" };
      } catch (cause) {
        reportFailure("cloud box could not be paused", { chatId: input.sandboxId, cause });
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox could not be paused.",
        };
      } finally {
        leaseOperations.delete(input.sandboxId);
      }
    },
    resume: (
      input: Pick<DiscoveredProvisionedEnvironment, "leaseId" | "sandboxId" | "environmentId">,
    ): Promise<EnvironmentProvisionResumeResult> => {
      const ownerKey = JSON.stringify([input.leaseId, input.environmentId]);
      const existing = leaseOperations.get(input.sandboxId);
      // A box is only checked before cleanup while due, and moving its clock makes it no longer
      // due, so the sweep puts it back to sleep instead of removing it. Once its removal has begun
      // the touch cannot stop it, so only a hold still checking promises a postponed cleanup.
      if (existing?.action === "clean")
        return (async (): Promise<EnvironmentProvisionResumeResult> => {
          const touched = await leaseRegistry?.touch(input.leaseId).catch(() => null);
          return {
            kind: "refused",
            reason: "unknown",
            message:
              touched && leaseOperations.get(input.sandboxId)?.action === "clean"
                ? "This machine is being checked before cleanup. Cleanup is postponed; open it again in a few minutes."
                : "Another workspace operation is in progress. Retry shortly.",
          };
        })();
      if (existing)
        return existing.action === "resume" && existing.ownerKey === ownerKey
          ? existing.promise
          : Promise.resolve({
              kind: "refused",
              reason: "unknown",
              message: "Another workspace operation is in progress. Retry shortly.",
            });
      const promise = (async (): Promise<EnvironmentProvisionResumeResult> => {
        const lease = await leaseRegistry?.findBySandbox(input.sandboxId);
        if (
          !leaseRegistry ||
          !lease ||
          lease.leaseId !== input.leaseId ||
          (lease.owner !== null && lease.owner.environmentId !== input.environmentId) ||
          (lease.state !== "active" && lease.state !== "paused" && lease.state !== "missing")
        )
          return {
            kind: "refused",
            reason: "unknown",
            message: "This workspace could not be found. Reconnect was refused.",
          };
        if (lease.state === "missing") throw new ProvisionedSandboxMissing();
        await wake(lease, input.environmentId);
        return { kind: "resumed" };
      })()
        .catch(async (cause): Promise<EnvironmentProvisionResumeResult> => {
          if (cause instanceof ProvisionedSandboxMissing)
            await leaseRegistry?.markMissing(input.leaseId);
          if (cause instanceof ProvisionedSandboxMissing)
            return { kind: "refused", reason: "missing", message: cause.message };
          return cause instanceof E2bPlacementUnavailable
            ? {
                kind: "refused",
                reason: "unknown",
                cause: cause.failure,
                message:
                  cause.failure === "provider-unavailable"
                    ? "E2B couldn't start this machine yet. The problem is on E2B's side."
                    : "Couldn't reach E2B to start this machine yet.",
              }
            : {
                kind: "refused",
                reason: "unknown",
                message: "The workspace could not be reconnected. Retry shortly.",
              };
        })
        .finally(() => leaseOperations.delete(input.sandboxId));
      leaseOperations.set(input.sandboxId, { action: "resume", ownerKey, promise });
      return promise;
    },
    touch: async (
      input: EnvironmentProvisionTouchInput,
    ): Promise<EnvironmentProvisionTouchResult> => {
      if (!leaseRegistry)
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox lease registry is unavailable.",
        };
      const lease = await leaseRegistry.findById(input.leaseId);
      if (!lease || lease.owner === null || (lease.state !== "active" && lease.state !== "paused"))
        return {
          kind: "refused",
          reason: lease?.state === "missing" ? "missing" : "unknown",
          message:
            lease?.state === "missing"
              ? new ProvisionedSandboxMissing().message
              : "The cloud sandbox lease could not be renewed.",
        };
      if (leaseOperations.has(lease.sandboxId))
        return {
          kind: "refused",
          reason: "unknown",
          message: "Another workspace operation is in progress. Retry shortly.",
        };
      leaseOperations.set(lease.sandboxId, { action: "renew" });
      try {
        if (!lease.namespaceResource) {
          const state = await driver.renew({
            sandboxId: lease.sandboxId,
            providerInstanceId: lease.providerInstanceId,
          });
          if (state === "missing") {
            await leaseRegistry.markMissing(lease.leaseId);
            return {
              kind: "refused",
              reason: "missing",
              message: new ProvisionedSandboxMissing().message,
            };
          }
          if (state === "paused") {
            await leaseRegistry.markPaused(lease.leaseId);
            return {
              kind: "refused",
              reason: "unknown",
              message: "The workspace is paused. Reconnect to continue.",
            };
          }
        }
        const renewed = lease.namespaceResource
          ? await leaseRegistry.touch(input.leaseId)
          : await leaseRegistry.markActive({ leaseId: input.leaseId });
        return renewed
          ? { kind: "touched" }
          : {
              kind: "refused",
              reason: "unknown",
              message: "The cloud sandbox lease could not be renewed.",
            };
      } catch {
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox deadline could not be renewed. Retry shortly.",
        };
      } finally {
        leaseOperations.delete(lease.sandboxId);
      }
    },
    reapExpiredLeases,
    /** Puts a paused box back to sleep after work outside this service woke it. */
    sleepBox: async (lease: ProvisionedLease): Promise<void> => {
      await driver.pause({
        sandboxId: lease.sandboxId,
        ...(lease.namespaceResource ? { namespaceResource: lease.namespaceResource } : {}),
      });
    },
    /**
     * Marks a box held for cleanup as being removed, so a resume from here on no longer postpones
     * it. Called before the sweep's last check of the lease.
     */
    beginRemoval: (sandboxId: string) => {
      if (leaseOperations.get(sandboxId)?.action === "clean")
        leaseOperations.set(sandboxId, { action: "dispose" });
    },
    /**
     * Takes a box's per-box lock for work outside this service, or null while it is held. A resume
     * that meets a "clean" hold postpones that box's cleanup.
     */
    holdBox: (sandboxId: string, action: "hold" | "clean" = "hold") => {
      if (leaseOperations.has(sandboxId)) return null;
      leaseOperations.set(sandboxId, { action });
      return () => {
        leaseOperations.delete(sandboxId);
      };
    },
    /**
     * Starts an upkeep pass for each awake instance-engine chat not already in one: a save of what
     * changed, or a release ahead of its Mac's deadline, under the same per-box lock as pause and
     * resume. Each chat runs on its own, so one slow save never delays another chat's deadline.
     */
    upkeepCloudChats: async (): Promise<void> => {
      const upkeepChat = driver.upkeepChat;
      if (!leaseRegistry || !upkeepChat) return;
      const passes: Array<Promise<void>> = [];
      for (const lease of await leaseRegistry.awake()) {
        if (lease.state !== "active" || leaseOperations.has(lease.sandboxId)) continue;
        leaseOperations.set(lease.sandboxId, { action: "save" });
        passes.push(
          (async () => {
            try {
              const result = await upkeepChat({
                sandboxId: lease.sandboxId,
                idle: async () => (await activity(lease)) === "idle",
              });
              if (result === "released") await leaseRegistry.markPaused(lease.leaseId);
              if (result === "missing") await leaseRegistry.markMissing(lease.leaseId);
              // Still held, so neither the reaper nor a client's pause lands between the move's
              // release and its new Mac. A failed move leaves the lease awake for the next pass.
              // Past the cap the chat sleeps as an idle one does, and opening it continues it; the
              // release also ends a move a host restart left on a half-restored Mac.
              if (result === "reopen") {
                const moves = (await leaseRegistry.findById(lease.leaseId))?.unwatchedMoves ?? 0;
                if (moves < MAX_UNWATCHED_MOVES)
                  await wake(lease, lease.owner?.environmentId, true);
                else if ((await driver.pause({ sandboxId: lease.sandboxId })) === "missing")
                  await leaseRegistry.markMissing(lease.leaseId);
                else await leaseRegistry.markPaused(lease.leaseId);
              }
            } catch (cause) {
              if (cause instanceof ProvisionedSandboxMissing)
                await leaseRegistry.markMissing(lease.leaseId).catch(() => undefined);
              // The next pass retries. A snapshot over its cap fails here every pass until the
              // deadline, so it must be visible.
              reportFailure("cloud chat upkeep failed", { chatId: lease.leaseId, cause });
            } finally {
              leaseOperations.delete(lease.sandboxId);
            }
          })(),
        );
      }
      await Promise.all(passes);
    },
    /**
     * Reads the chat of each awake claimed box the host holds none for, or holds another
     * thread's, so a new chat lists on other clients before the next usage sweep. One pass at a
     * time; a box read in the last minute, a box with its owner's chat and a paused box are never
     * read.
     */
    readNewChats: (): Promise<void> =>
      (readingNewChats ??= (async () => {
        if (!leaseRegistry || !chats) return;
        const held = await chats.heldThreads();
        const awake = await leaseRegistry.awake();
        const now = Date.now();
        for (const leaseId of newChatReadAt.keys())
          if (!awake.some((lease) => lease.leaseId === leaseId)) newChatReadAt.delete(leaseId);
        const queue = awake.filter(
          (lease) =>
            lease.owner !== null &&
            held.get(lease.leaseId) !== lease.owner.threadId &&
            now - (newChatReadAt.get(lease.leaseId) ?? -Infinity) >= NEW_CHAT_RETRY_MS,
        );
        for (const lease of queue) newChatReadAt.set(lease.leaseId, now);
        const read = async () => {
          for (let lease = queue.shift(); lease; lease = queue.shift()) await activity(lease);
        };
        await Promise.all(Array.from({ length: USAGE_SYNC_CONCURRENCY }, read));
      })()
        .catch((cause: unknown) =>
          reportFailure("new cloud box chats could not be read", { cause }),
        )
        .finally(() => {
          readingNewChats = undefined;
        })),
    /**
     * Pulls each awake box's usage when its agent settles from busy to idle,
     * or the first time it is seen idle. A failed pull retries next sweep.
     * A box whose chat stopped on a usage limit starts its account switch.
     */
    syncLeaseUsage: async (): Promise<void> => {
      if (!leaseRegistry) return;
      const awake = await leaseRegistry.awake();
      const awakeIds = new Set(awake.map((lease) => lease.leaseId));
      for (const leaseId of settledActivity.keys())
        if (!awakeIds.has(leaseId)) settledActivity.delete(leaseId);
      const queue = [...awake];
      const sync = async () => {
        for (let lease = queue.shift(); lease; lease = queue.shift()) {
          const observation = await observeAndKeep(lease);
          if (await rotationDue(lease, observation)) driver.accountRotation?.start(lease);
          const current = observation.activity;
          if (current === "busy") settledActivity.set(lease.leaseId, "busy");
          else if (current === "idle" && settledActivity.get(lease.leaseId) !== "idle") {
            try {
              await pullUsage(lease);
              settledActivity.set(lease.leaseId, "idle");
            } catch {
              // Left unsettled so the next sweep pulls again.
            }
          }
        }
      };
      await Promise.all(Array.from({ length: USAGE_SYNC_CONCURRENCY }, sync));
    },
  };
}

export class EnvironmentControl extends Context.Service<
  EnvironmentControl,
  {
    /** Resolve the manager-local namespace proxy for guest gateway traffic. */
    readonly namespaceProxyOrigin: (
      leaseId: string,
    ) => Effect.Effect<string | null, EnvironmentControlError>;
    readonly list: Effect.Effect<ReadonlyArray<ManagedEnvironment>, EnvironmentControlError>;
    /** The cloud configuration as last read from disk, or null when this install has none. */
    readonly controlConfig: Effect.Effect<EnvironmentControlConfig | null, EnvironmentControlError>;
    /** The cloud environments the current configuration can provision; none without one. */
    readonly provisionProviders: Effect.Effect<
      ReadonlyArray<ProvisionProvider>,
      EnvironmentControlError
    >;
    /**
     * The skills provisioning copies into each environment, by driver. Only a
     * host that runs no agents itself reports them, because its own provider
     * snapshots cannot see them. Absent on every other host.
     */
    readonly provisionedSkills: Effect.Effect<ServerProvisionedSkills | undefined>;
    /**
     * Also reports removed boxes that can still be restored, those of `knownEnvironmentIds` that
     * were this host's boxes and are gone, and those of `addresses` that dial such a box. With
     * `chats`, each box carries the chat the host last read from it, when newer than the one the
     * client holds.
     */
    readonly listProvisioned: (
      knownEnvironmentIds?: ReadonlyArray<EnvironmentId>,
      addresses?: ReadonlyArray<SavedEnvironmentAddress>,
      chats?: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly sequence: number }>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredProvisionedEnvironment>, EnvironmentControlError>;
    readonly start: (
      id: EnvironmentId,
    ) => Effect.Effect<EnvironmentControlResult, EnvironmentControlError>;
    readonly stop: (
      id: EnvironmentId,
    ) => Effect.Effect<EnvironmentControlResult, EnvironmentControlError>;
    readonly provision: (
      input: EnvironmentProvisionInput,
    ) => Effect.Effect<EnvironmentProvisionResult, EnvironmentControlError>;
    readonly attach: (
      input: EnvironmentProvisionAttachInput,
    ) => Effect.Effect<EnvironmentProvisionAttachResult, EnvironmentControlError>;
    readonly dispose: (
      input: EnvironmentProvisionDisposeInput,
    ) => Effect.Effect<EnvironmentProvisionDisposeResult, EnvironmentControlError>;
    readonly pause: (
      input: EnvironmentProvisionPauseInput,
    ) => Effect.Effect<EnvironmentProvisionPauseResult, EnvironmentControlError>;
    readonly claim: (
      input: EnvironmentProvisionClaimInput,
    ) => Effect.Effect<EnvironmentProvisionClaimResult, EnvironmentControlError>;
    readonly resume: (
      input: EnvironmentProvisionResumeInput,
    ) => Effect.Effect<EnvironmentProvisionResumeResult, EnvironmentControlError>;
    readonly touch: (
      input: EnvironmentProvisionTouchInput,
    ) => Effect.Effect<EnvironmentProvisionTouchResult, EnvironmentControlError>;
    /**
     * Keeps a cloud box from automatic cleanup, or allows it again. A box kept because its work
     * could not be backed up stays kept until it is next woken.
     */
    readonly keep: (
      input: EnvironmentProvisionKeepInput,
    ) => Effect.Effect<EnvironmentProvisionKeepResult, EnvironmentControlError>;
    readonly upgrade: (
      input: EnvironmentProvisionUpgradeInput,
    ) => Effect.Effect<EnvironmentProvisionUpgradeResult, EnvironmentControlError>;
    /**
     * Moves a cloud machine onto another account of the provider one of its chats runs on, and
     * continues that chat's run when a usage limit stopped it.
     */
    readonly switchAccount: (
      input: EnvironmentProvisionSwitchAccountInput,
    ) => Effect.Effect<EnvironmentProvisionSwitchAccountResult, EnvironmentControlError>;
    /** Brings a chat's removed box back asleep, as its chat left it, until its grace ends. */
    readonly restore: (
      input: EnvironmentProvisionRestoreInput,
    ) => Effect.Effect<EnvironmentProvisionRestoreResult, EnvironmentControlError>;
    /**
     * A client's report of whether its user is here. While any client's user is, the host wakes
     * their unsettled cloud chats ahead of them and keeps them awake. Answers with the machines
     * waking or updating right now.
     */
    readonly presence: (
      input: EnvironmentControlPresenceInput,
    ) => Effect.Effect<EnvironmentControlPresenceResult, EnvironmentControlError>;
  }
>()("t3/environmentControl/EnvironmentControl") {}

/**
 * Moves a woken box onto the pinned build before anyone connects, since a client refuses a server
 * on an older orchestration protocol. It is a no-op for a box already on it, and a paused box ran
 * no turn to cut. Another caller's upgrade in flight is waited out; a box left behind is refused.
 */
export const upgradeAfterResume = (
  upgrade: Effect.Effect<EnvironmentProvisionUpgradeResult, EnvironmentControlError>,
): Effect.Effect<EnvironmentProvisionResumeResult> =>
  upgrade.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })),
      while: (upgraded) => upgraded.kind === "refused" && upgraded.reason === "busy",
    }),
    Effect.map((upgraded): EnvironmentProvisionResumeResult => {
      if (upgraded.kind !== "refused" || upgraded.reason === "unconfigured") {
        return { kind: "resumed" };
      }
      return {
        kind: "refused",
        reason: upgraded.reason === "missing" ? "missing" : "unknown",
        message: upgraded.message,
      };
    }),
    Effect.catch((error) =>
      Effect.succeed({
        kind: "refused" as const,
        reason: "unknown" as const,
        message: error.message,
      }),
    ),
  );

/**
 * A resume whose guest could not be brought up may be stuck on a build that cannot start, such as
 * one an earlier upgrade installed. Upgrading onto the pinned build is safe there, since a guest
 * that is not serving runs no turn, so the box recovers once the host pins a working build. A
 * machine its provider could not start has no guest to upgrade, so it is left to the next wake.
 */
export const recoverRefusedResume = (
  refused: EnvironmentProvisionResumeResult,
  upgrade: Effect.Effect<EnvironmentProvisionUpgradeResult, EnvironmentControlError>,
): Effect.Effect<EnvironmentProvisionResumeResult> =>
  refused.kind === "refused" && refused.reason === "unknown" && refused.cause === undefined
    ? upgrade.pipe(
        Effect.map((upgraded): EnvironmentProvisionResumeResult =>
          upgraded.kind === "upgraded" ? { kind: "resumed" } : refused,
        ),
        Effect.catch(() => Effect.succeed(refused)),
      )
    : Effect.succeed(refused);

export const layer = Layer.effect(
  EnvironmentControl,
  Effect.gen(function* () {
    const { stateDir, localAgentRuns, secretsDir } = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
    const boxUsage = yield* BoxUsageStore;
    const manifests = makeProvisionPreparationStore(stateDir);
    const legacyLeases = yield* Effect.tryPromise({
      try: () =>
        NodeFSP.readFile(NodePath.join(stateDir, "provisioned-sandbox-leases.json"), "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "[]";
            throw error;
          },
        ),
      catch: () =>
        new EnvironmentControlError({ message: "Existing cloud leases could not be loaded." }),
    });
    const leaseRegistry = createProvisionedLeaseRegistry(sql, legacyLeases);
    const chatStore = createProvisionedChatStore(sql);
    const namespaceProxies = new NamespaceProxyManager();
    const importedLeases = new Map(
      decodeLegacyLeases(legacyLeases).map((lease) => [lease.leaseId, lease]),
    );
    type ManagerService = ReturnType<typeof createEnvironmentControl> & {
      config: Awaited<ReturnType<typeof readConfig>>;
    };
    let loaded:
      | {
          readonly path: string;
          readonly mtimeMs: number;
          readonly service: Promise<ManagerService | null>;
        }
      | undefined;
    let namespace:
      | Promise<{
          allocator: ReturnType<typeof makeNamespaceAllocationPorts>;
          runtime: ReturnType<typeof makeNamespaceProvisionRuntime>;
          mac: ReturnType<typeof makeNamespaceMacRuntime>;
        }>
      | undefined;
    let scannedSkills:
      | {
          readonly service: ManagerService;
          readonly mtimes: string;
          readonly skills: Promise<ServerProvisionedSkills>;
        }
      | undefined;
    const settings = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const profileContext = yield* Effect.context<Path.Path | FileSystem.FileSystem>();
    // Promise-side provider code logs through the server's logger, not the default one.
    const runLogged = Effect.runPromiseWith(yield* Effect.context<never>());
    const logE2bResumeRetry = (retry: E2bResumeRetry) =>
      void runLogged(
        Effect.logWarning("E2B could not resume a cloud workspace yet; retrying", retry),
      );
    const pullUsage = async (lease: ProvisionedLease) => {
      await serveProxy(lease);
      return runLogged(
        pullLeaseUsage(boxUsage, lease).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("cloud box usage could not be pulled", {
              leaseId: lease.leaseId,
              cause,
            }),
          ),
        ),
      );
    };
    const logRefresh = (leaseId: string, refreshError: string | null | undefined) =>
      refreshError
        ? Effect.logWarning("cloud checkout could not fetch its branch", {
            leaseId,
            cause: refreshError,
          })
        : Effect.void;
    const resolveAccounts = async <A>(
      resolveFrom: (
        current: ServerSettings,
      ) => Effect.Effect<A, unknown, Path.Path | FileSystem.FileSystem>,
    ) => {
      const result = await Effect.runPromiseWith(profileContext)(
        settings.getSettings.pipe(
          Effect.flatMap(resolveFrom),
          Effect.match({
            onSuccess: (profile) => ({ kind: "resolved" as const, profile }),
            onFailure: (error) => ({ kind: "refused" as const, error }),
          }),
        ),
      );
      if (result.kind === "refused")
        throw isProvisionRefused(result.error)
          ? result.error
          : new ProvisionRefused({
              reason: "unconfigured",
              message: "Provider account settings could not be read.",
            });
      return result.profile;
    };
    const resolve = () =>
      (async () => {
        const path = await resolveControlConfigPath({
          explicit: process.env.T3CODE_ENVIRONMENT_CONTROL_CONFIG,
          stateDir,
          fallback: NodePath.join(NodeOS.homedir(), ".t3", "environment-control.json"),
        });
        if (!path) {
          loaded = undefined;
          namespace = undefined;
          return null;
        }
        const mtimeMs = await NodeFSP.stat(path)
          .then((stats) => stats.mtimeMs)
          .catch(() => null);
        if (mtimeMs === null) return null;
        if (loaded?.path === path && loaded.mtimeMs === mtimeMs) return loaded.service;
        namespace = undefined;
        const service = (async () => {
          const config = await readConfig(path);
          const cloud = createCloudDriver(config, logE2bResumeRetry);
          const control = createEnvironmentControl(
            config.targets,
            {
              ...cloud,
              // A chat on the instance engine owns no Devbox or sandbox: its Mac is
              // released, renewed and disposed through the runtime that keeps its snapshot.
              pause: async (input) => {
                const chat = await instanceChat(input.sandboxId);
                if (!chat) return cloud.pause(input);
                return (await chat.mac.release(chat.operation, chat.manifest)) === "missing"
                  ? "missing"
                  : undefined;
              },
              dispose: async (input) => {
                const chat = await instanceChat(input.sandboxId);
                if (!chat) return cloud.dispose(input);
                await chat.mac.dispose(chat.operation, chat.manifest);
              },
              renew: async (input) => {
                const chat = await instanceChat(input.sandboxId);
                if (!chat) return cloud.renew(input);
                const state = await chat.mac.touch(chat.operation);
                return state === "released" ? "paused" : state;
              },
              upkeepChat: async ({ sandboxId, idle }) => {
                const chat = await instanceChat(sandboxId);
                return chat ? chat.mac.upkeep(chat.operation, chat.manifest, idle) : null;
              },
              idleUpgrade: {
                due: async (lease) => {
                  if (!isProvisionRequestId(lease.leaseId) || importedLeases.has(lease.leaseId))
                    return null;
                  const operation = await Effect.runPromise(store.get(lease.leaseId)).catch(
                    () => null,
                  );
                  if (operation?.state.kind !== "ready") return null;
                  // Read per sweep: upkeep keeps the service it started with, and the pinned
                  // build follows config edits.
                  const current = await resolve();
                  const pinned = current
                    ? configuredRuntimeArtifact(
                        current.config,
                        operation.state.allocation.resource.provider,
                      )
                    : null;
                  return pinned && pinned.sha256 !== operation.state.readiness.artifactSha256
                    ? pinned.sha256
                    : null;
                },
                start: (lease) => void runLogged(upgradeIdleBox(lease)),
              },
              accountRotation: {
                due: (lease, chat) => accountRotation.due(lease, chat),
                start: (lease) => void accountRotation.start(lease),
              },
              boxBackup: {
                sleepBudgetMs: SLEEP_BACKUP_BUDGET_MS,
                run: async (lease, deadline) => {
                  if (!isProvisionRequestId(lease.leaseId) || importedLeases.has(lease.leaseId))
                    return null;
                  const operation = await Effect.runPromise(store.get(lease.leaseId)).catch(
                    () => null,
                  );
                  if (
                    !operation ||
                    operation.state.kind !== "ready" ||
                    operation.state.allocation.resource.provider !== "e2b"
                  )
                    return null;
                  const manifest = await manifests.load(lease.leaseId);
                  const token = config.provisioning?.githubToken;
                  const outputsUri = config.provisioning?.workerForks?.outputsUri;
                  const sessions =
                    outputsUri && lease.owner
                      ? {
                          uri: cloudBackupUri(outputsUri, lease.owner.environmentId),
                          environmentId: lease.owner.environmentId,
                          account: leaseAccounts(lease)[0] ?? lease.providerInstanceId,
                          threadId: lease.owner.threadId,
                        }
                      : undefined;
                  return makeE2bProvisionRuntime({ apiKey: config.e2bApiKey }).backUp(
                    operation,
                    operation.state.allocation.resource.sandboxId,
                    manifest,
                    {
                      leaseId: lease.leaseId,
                      target: workTarget({
                        originIsPrivate: await repositoryIsPrivate(
                          operation.request.repository,
                          token,
                        ),
                        token,
                        bundlePath: sessions
                          ? `${manifest.preparation.root}/backup/work.bundle`
                          : undefined,
                      }),
                      ...(sessions ? { sessions } : {}),
                      previous: lease.backup,
                      now: new Date().toISOString(),
                    },
                    deadline,
                  );
                },
              },
              // A box this manager provisioned resumes through the runtime that
              // prepared it, which starts its T3 server again if it died and
              // fetches its followed branch so the thread sees what was pushed
              // while it slept. Imported leases keep the legacy runner.
              resume: async (input) => {
                try {
                  if (importedLeases.has(input.leaseId) || !isProvisionRequestId(input.leaseId))
                    return await cloud.resume(input);
                  if (input.namespaceResource || (await instanceChat(input.sandboxId)))
                    return await resumeProvisionedNamespace(input.leaseId, input.namespaceProxy);
                  const resumed = await cloud.resume(input);
                  // An awake sandbox is not a resumed chat until its T3 server answers.
                  // A refused one is still awake, so its lease says so and the reaper
                  // pauses it, rather than leaving it running out E2B's six-hour timeout.
                  await resumeProvisionedE2b(input.leaseId, config.e2bApiKey).catch(
                    async (cause: unknown) => {
                      await leaseRegistry.markActive({ leaseId: input.leaseId });
                      throw cause;
                    },
                  );
                  return resumed;
                } catch (cause) {
                  if (!(cause instanceof ProvisionedSandboxMissing))
                    await runLogged(
                      Effect.logError("cloud workspace could not be resumed", {
                        leaseId: input.leaseId,
                        cause,
                      }),
                    );
                  throw cause;
                }
              },
            },
            leaseRegistry,
            // A Namespace box is read through this process's proxy, which a restart drops. Serve
            // it again first, or the reaper and a Mac's deadline upkeep read a working box as
            // unknown and pause it.
            async (lease) => {
              await serveProxy(lease);
              return observeLease(lease);
            },
            pullUsage,
            (message, fields) => void runLogged(Effect.logError(message, fields)),
            chatStore,
          );
          return { ...control, config };
        })();
        loaded = { path, mtimeMs, service };
        return service.catch((error: unknown) => {
          if (loaded?.path === path && loaded.mtimeMs === mtimeMs) loaded = undefined;
          throw error;
        });
      })();
    const resolveNamespace = () => {
      namespace ??= (async () => {
        const manager = await resolve();
        if (!manager)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "This install has no cloud provisioning configuration.",
          });
        const session = await makeNamespaceAccountSession({
          stateDir,
          ...(manager.config.namespaceToken ? { token: manager.config.namespaceToken } : {}),
        });
        return {
          allocator: makeNamespaceAllocationPorts({
            client: session.client,
            identity: session.identity,
            execute: async (args, signal) => {
              const result = await session.run(args, signal);
              if (result.exitCode !== 0)
                throw new Error(
                  provisionFailureMessage(
                    new Error(result.stderr?.trim() || result.stdout?.trim() || ""),
                    "Namespace allocation command did not finish.",
                  ),
                );
            },
          }),
          runtime: makeNamespaceProvisionRuntime({ session, stateDir, proxies: namespaceProxies }),
          mac: makeNamespaceMacRuntime({
            session,
            stateDir,
            proxies: namespaceProxies,
            // Read per build, so a config change takes effect without a restart.
            currentTemplate: async (repository) => {
              const current = await resolve();
              return current ? currentMacTemplate(current.config, repository) : null;
            },
            log: (message, fields) =>
              void runLogged(Effect.logInfo(message).pipe(Effect.annotateLogs(fields))),
            warn: (message, fields) =>
              void runLogged(Effect.logWarning(message).pipe(Effect.annotateLogs(fields))),
          }),
        };
      })();
      void namespace.catch(() => {
        namespace = undefined;
      });
      return namespace;
    };
    const resumeProvisionedNamespace = async (
      requestId: ProvisionRequestId,
      recordedProxy?: NamespaceProxyLease,
    ) => {
      const operation = await Effect.runPromise(store.get(requestId));
      if (
        operation.state.kind !== "ready" ||
        operation.state.allocation.resource.provider !== "namespace"
      )
        throw new Error("No ready Namespace runtime");
      const manifest = await manifests.load(requestId);
      const build = await manifests.readRuntime(requestId);
      const { runtime, mac } = await resolveNamespace();
      const resource = operation.state.allocation.resource;
      const { namespaceProxy, refreshError } =
        "engine" in resource
          ? await mac.resume(operation, manifest, recordedProxy, build)
          : await runtime.resume(operation, resource, manifest, recordedProxy, build);
      await runLogged(logRefresh(requestId, refreshError));
      return { namespaceProxy };
    };
    /**
     * Proxies live in this process, so a restart leaves every active lease's recorded origin
     * unserved until something publishes it again. `serveProxy` does, on the first read that needs
     * it, from the gateway or this manager. It runs once per lease at a time, and at most every
     * RECONNECT_RETRY_MS after a failure.
     */
    const reconnecting = new Map<string, Promise<void>>();
    const reconnectFailedAt = new Map<string, number>();
    const reconnectProxy = (lease: ProvisionedLease, recorded: NamespaceProxyLease) => {
      const requestId = lease.leaseId;
      if (!isProvisionRequestId(requestId) || importedLeases.has(requestId))
        return Promise.resolve();
      const failedAt = reconnectFailedAt.get(requestId);
      if (failedAt !== undefined && Date.now() - failedAt < RECONNECT_RETRY_MS)
        return Promise.resolve();
      const pending =
        reconnecting.get(requestId) ??
        (async () => {
          const operation = await Effect.runPromise(store.get(requestId));
          if (
            operation.state.kind !== "ready" ||
            operation.state.allocation.resource.provider !== "namespace"
          )
            return;
          const manifest = await manifests.load(requestId);
          const { runtime, mac } = await resolveNamespace();
          const resource = operation.state.allocation.resource;
          await ("engine" in resource
            ? mac.reconnect(operation, manifest, recorded)
            : runtime.reconnect(operation, resource, manifest, recorded));
          reconnectFailedAt.delete(requestId);
          await runLogged(
            Effect.logInfo("cloud workspace proxy reconnected", {
              leaseId: requestId,
              proxyOrigin: recorded.proxyOrigin,
            }),
          );
        })()
          .catch(async (cause: unknown) => {
            reconnectFailedAt.set(requestId, Date.now());
            await runLogged(
              Effect.logWarning("cloud workspace proxy could not be reconnected", {
                leaseId: requestId,
                cause,
              }),
            );
          })
          .finally(() => reconnecting.delete(requestId));
      reconnecting.set(requestId, pending);
      return pending;
    };
    /** Serves an active lease's recorded proxy again, if a restart left it unserved. */
    const serveProxy = async (lease: ProvisionedLease) => {
      if (lease.state !== "active" || !lease.namespaceProxy) return;
      // A proxy being restored is registered before it listens, so a read waits for the restore.
      await reconnecting.get(lease.leaseId);
      if (!namespaceProxies.has(lease.namespaceProxy.proxyId))
        await reconnectProxy(lease, lease.namespaceProxy);
    };
    /** The chat behind a lease, when it runs on the Namespace instance engine. */
    const instanceChat = async (sandboxId: string) => {
      if (!isProvisionRequestId(sandboxId) || importedLeases.has(sandboxId)) return null;
      const operation = await Effect.runPromise(store.get(sandboxId)).catch(() => null);
      if (
        !operation ||
        !allocatedResources(operation.state).some((resource) => "engine" in resource)
      )
        return null;
      return {
        operation,
        manifest: await manifests.load(sandboxId),
        mac: (await resolveNamespace()).mac,
      };
    };
    const resumeProvisionedE2b = async (requestId: ProvisionRequestId, apiKey: string) => {
      const operation = await Effect.runPromise(store.get(requestId));
      if (
        operation.state.kind !== "ready" ||
        operation.state.allocation.resource.provider !== "e2b"
      )
        throw new Error("No ready E2B runtime");
      const { refreshError, restarted } = await makeE2bProvisionRuntime(
        { apiKey },
        logE2bResumeRetry,
      ).resume(
        operation,
        operation.state.allocation.resource.sandboxId,
        await manifests.load(requestId),
        await manifests.readRuntime(requestId),
      );
      if (restarted)
        await runLogged(
          Effect.logWarning("cloud workspace server was down; prepared it again", {
            leaseId: requestId,
          }),
        );
      await runLogged(logRefresh(requestId, refreshError));
    };
    const provider = (operation: ProvisionOperation) =>
      Effect.tryPromise(async () => {
        const manager = await resolve();
        if (!manager) throw new Error("Missing cloud configuration");
        const manifest = await manifests.load(operation.request.requestId);
        const build = await manifests.readRuntime(operation.request.requestId);
        const connection = { apiKey: manager.config.e2bApiKey };
        return {
          manifest,
          build,
          namespace: operation.request.provider === "namespace" ? await resolveNamespace() : null,
          runtime: makeE2bProvisionRuntime(connection, logE2bResumeRetry),
          allocator: makeE2bAllocationPorts({
            connection,
            parentTimeoutMs: 10 * 60_000,
            sandboxTimeoutMs: 6 * 3_600_000,
            ...(manifest.egressAllow.length
              ? { network: { allowOut: [...manifest.egressAllow], denyOut: [ALL_TRAFFIC] } }
              : {}),
          }),
        };
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logError("provisioning inputs could not be loaded", { cause }),
        ),
        Effect.mapError(
          () =>
            new ProvisionProviderError({
              message: "The manager could not load the immutable provisioning inputs.",
            }),
        ),
      );
    /** An instance-engine chat names no machine, so allocating it calls no provider. */
    const chatResource = (operation: ProvisionOperation) =>
      operation.request.provider === "namespace" && operation.request.engine === "instance"
        ? ({
            provider: "namespace",
            engine: "instance",
            chatId: operation.request.requestId,
          } as const)
        : null;
    const ports: ProvisionProviderPorts["Service"] = {
      create: (operation) => {
        const chat = chatResource(operation);
        if (chat) return Effect.succeed(chat);
        return Effect.flatMap(provider(operation), ({ allocator, namespace }) =>
          (namespace?.allocator ?? allocator).create(operation),
        );
      },
      recoverCreate: (operation) => {
        const chat = chatResource(operation);
        if (chat) return Effect.succeed([chat]);
        return Effect.flatMap(provider(operation), ({ allocator, namespace }) =>
          (namespace?.allocator ?? allocator).recoverCreate(operation),
        );
      },
      fork: (operation, parent) =>
        Effect.flatMap(provider(operation), ({ allocator }) => allocator.fork(operation, parent)),
      recoverFork: (operation, parent) =>
        Effect.flatMap(provider(operation), ({ allocator }) =>
          allocator.recoverFork(operation, parent),
        ),
      dispose: (operation, resource) =>
        Effect.gen(function* () {
          const { runtime, namespace, manifest } = yield* provider(operation);
          if (resource.provider === "namespace")
            return yield* Effect.tryPromise({
              try: async () => {
                if (!namespace) throw new Error("Namespace unavailable");
                if ("engine" in resource) await namespace.mac.dispose(operation, manifest);
                else await namespace.runtime.dispose(operation, resource);
              },
              catch: () =>
                new ProvisionProviderError({
                  message: "Namespace cleanup could not be confirmed.",
                }),
            });
          const sandboxId = resource.sandboxId;
          yield* Effect.tryPromise({
            try: () => runtime.dispose(operation, sandboxId),
            catch: () =>
              new ProvisionProviderError({
                message: "The allocated resource could not be confirmed disposed.",
              }),
          });
        }),
      prepare: (operation, allocation) => {
        // Sub-phases are collected rather than logged as they happen because the
        // provider runtimes are Promise-side with no Effect runtime in scope, so
        // their log timestamps cluster at the drain while the durations stay exact.
        const phases: ProvisionPhase[] = [];
        const record = (phase: ProvisionPhase) => {
          phases.push(phase);
        };
        return Effect.gen(function* () {
          const { runtime, manifest, namespace, build } = yield* provider(operation);
          const resource = allocation.resource;
          const request = operation.request;
          if (resource.provider === "namespace")
            return yield* Effect.tryPromise({
              try: async () => {
                if (!namespace) throw new Error("Namespace unavailable");
                if ("engine" in resource)
                  return namespace.mac.prepare(operation, manifest, record, build);
                return namespace.runtime.prepare(operation, resource, manifest, record, build);
              },
              catch: (error) =>
                new ProvisionProviderError({
                  ...(error instanceof ProvisionRetentionError ? { retentionFailed: true } : {}),
                  message: provisionFailureMessage(
                    error,
                    "Namespace preparation did not finish. Retry the same request.",
                  ),
                }),
            }).pipe(
              // A chat that could not prepare on a spare sends later chats cold,
              // like one that could not on a warm base.
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (
                    request.provider === "namespace" &&
                    request.devboxName &&
                    manifest.warmKey &&
                    manifest.input.repository &&
                    build === null &&
                    !error.retentionFailed &&
                    // Only a chat's first failure. Its retries run on the same
                    // spare and say nothing about the ones built since.
                    operation.state.kind === "preparing" &&
                    operation.state.lastError === null
                  )
                    spares.failed(manifest.input.repository, manifest.warmKey, error.message);
                }),
              ),
            );
          const sandboxId = resource.sandboxId;
          return yield* Effect.tryPromise({
            try: () => runtime.prepare(operation, sandboxId, manifest, record, build),
            catch: (error) =>
              new ProvisionProviderError({
                ...(error instanceof ProvisionRetentionError ? { retentionFailed: true } : {}),
                message: provisionFailureMessage(
                  error,
                  "Remote preparation did not finish. Retry the same request to resume.",
                ),
              }),
          }).pipe(
            // A chat that could not prepare on a warm base's tree sends later
            // chats cold until a new base exists. An upgrade or an expired
            // retention is not the base's fault.
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (
                  request.provider === "e2b" &&
                  request.strategy === "direct" &&
                  manifest.warmKey &&
                  manifest.input.repository &&
                  build === null &&
                  !error.retentionFailed
                )
                  warmBases.failed(manifest.input.repository, request.templateId, error.message);
              }),
            ),
          );
        }).pipe(
          Effect.tap((ready) => logRefresh(operation.request.requestId, ready.refreshError)),
          Effect.ensuring(
            logProvisionPhases(
              {
                requestId: operation.request.requestId,
                provider: allocation.resource.provider,
              },
              phases,
            ),
          ),
        );
      },
    };
    const provisioning = yield* Provisioning.make.pipe(
      Effect.provideService(ProvisionProviderPorts, {
        ...ports,
        // Bound late: ProvisionControl is built on top of this provisioning service.
        ready: (operation) => Effect.suspend(() => provisionControl.settleChat(operation)),
      }),
    );
    const requireManager = async () => {
      const manager = await resolve();
      if (!manager)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: "This install has no cloud provisioning configuration.",
        });
      return manager;
    };
    const resolution = (config: EnvironmentControlConfig) =>
      makeProvisionResolution({
        apiKey: config.e2bApiKey,
        ...(config.provisioning?.githubToken
          ? { githubToken: config.provisioning.githubToken }
          : {}),
      });
    /** The one freeze path, shared by chats and warm base builds. */
    const freeze = async (
      input: EnvironmentProvisionInput,
      warmTemplate?: Parameters<typeof manifests.freeze>[4],
      spareClaim?: Parameters<typeof manifests.freeze>[5],
    ) => {
      const manager = await requireManager();
      if (input.provider === "namespace") {
        if (!manager.config.provisioning?.runtimeArtifacts?.macos)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "Configure a pinned macOS runtime artifact before provisioning.",
          });
        try {
          await resolveNamespace();
        } catch (error) {
          if (isProvisionRefused(error)) throw error;
          throw new ProvisionRefused({
            reason: "credentials",
            message: provisionFailureMessage(
              error,
              "Log in with nsc login, or set namespaceToken in environment-control.json.",
            ),
          });
        }
      }
      return manifests.freeze(
        input,
        manager.config,
        resolution(manager.config),
        // Credentials and skill roots follow the accounts' real settings
        // rather than paths this module guesses from driver names.
        // Each driver runs on the account with the most usage left per
        // active session right now. The manifest freezes that choice, so
        // a retry keeps it without routing again.
        () =>
          resolveAccounts((current) =>
            Effect.all({
              providers: providerRegistry.getProviders,
              now: Clock.currentTimeMillis,
              load: readAccountLoad(leaseRegistry, sql, store),
            }).pipe(
              Effect.flatMap((usage) =>
                resolveProvisioningProfiles(
                  current,
                  {
                    providerInstanceId: input.providerInstanceId,
                    ...(input.agentDriver ? { agentDriver: input.agentDriver } : {}),
                    pinAccount: input.pinAccount,
                  },
                  manager.config.provisioning?.claudeOAuthTokens,
                  usage,
                  {
                    localAgentRuns,
                    secretsDir,
                    // The instance's status probe refreshes a host's own
                    // login, serialized with its usage probes.
                    refresh: (instanceId) =>
                      providerRegistry.refreshInstance(instanceId).pipe(Effect.asVoid),
                  },
                ),
              ),
            ),
          ),
        warmTemplate,
        spareClaim,
      );
    };
    const warmStore = makeWarmBaseStore(stateDir);
    const readyE2bBuild = async (operation: ProvisionOperation) => {
      const manager = await requireManager();
      if (
        operation.state.kind !== "ready" ||
        operation.state.allocation.resource.provider !== "e2b"
      )
        throw new Error("The warm base build is not a ready E2B box.");
      return {
        runtime: makeE2bProvisionRuntime({ apiKey: manager.config.e2bApiKey }, logE2bResumeRetry),
        sandboxId: operation.state.allocation.resource.sandboxId,
      };
    };
    /** What building a base takes on either provider. */
    const buildPorts = {
      now: Date.now,
      ensure: async (requestId: ProvisionRequestId) =>
        runLogged(provisioning.ensure((await manifests.load(requestId)).request)),
      cancel: async (requestId: ProvisionRequestId) => {
        // A build abandoned before it was first driven has no operation yet.
        await runLogged(store.accept((await manifests.load(requestId)).request));
        return runLogged(provisioning.cancel(requestId));
      },
      warn: (message: string, context: Record<string, unknown>) =>
        void runLogged(Effect.logWarning(message, context)),
    };
    const logBases = (provider: "e2b" | "namespace") => ({
      info: (message: string, context: Record<string, unknown>) =>
        void runLogged(Effect.logInfo(message, { provider, ...context })),
    });
    const warmBases = makeWarmBaseUpkeep({
      ...buildPorts,
      ...logBases("e2b"),
      store: warmStore,
      key: async (repository) => {
        const manager = await resolve();
        return manager ? warmBaseKey(manager.config, repository, resolution(manager.config)) : null;
      },
      // A build is a cold chat on the repository's default branch. It never
      // registers a lease, so discovery never offers it to anyone.
      freezeBuild: async ({ requestId, repository, seed, retentionDeadline }) =>
        (
          await freeze({
            requestId,
            provider: "e2b",
            providerInstanceId: seed.providerInstanceId,
            ...(seed.agentDriver ? { agentDriver: seed.agentDriver } : {}),
            repository,
            retentionDeadline,
          })
        ).warmKey,
      buildSnapshots: async (requestId) => {
        const operation = await runLogged(store.accept((await manifests.load(requestId)).request));
        const runtime = makeE2bProvisionRuntime({
          apiKey: (await requireManager()).config.e2bApiKey,
        });
        const snapshotIds: string[] = [];
        for (const resource of allocatedResources(operation.state))
          if (resource.provider === "e2b")
            snapshotIds.push(...(await runtime.snapshotsOf(resource.sandboxId)));
        return snapshotIds;
      },
      seal: async (operation) => {
        const { runtime, sandboxId } = await readyE2bBuild(operation);
        await runtime.seal(operation, sandboxId, await manifests.load(operation.request.requestId));
      },
      capture: async (operation) => {
        const { runtime, sandboxId } = await readyE2bBuild(operation);
        return runtime.snapshot(operation, sandboxId);
      },
      deleteSnapshot: async (snapshotId) =>
        makeE2bProvisionRuntime({
          apiKey: (await requireManager()).config.e2bApiKey,
        }).deleteSnapshot(snapshotId),
    });
    const spareStore = makeWarmBaseStore(stateDir, "spares");
    const spareClaims = makeSpareClaims(stateDir);
    const spares = makeWarmBaseUpkeep({
      ...buildPorts,
      ...logBases("namespace"),
      store: spareStore,
      key: async (repository) => {
        const manager = await resolve();
        return manager ? spareKey(manager.config, repository) : null;
      },
      // A cold chat on the default branch, like a warm base build, but with no
      // retention deadline: the Devbox it makes outlives the build as the spare.
      freezeBuild: async ({ requestId, repository, seed }) =>
        (
          await freeze({
            requestId,
            provider: "namespace",
            providerInstanceId: seed.providerInstanceId,
            ...(seed.agentDriver ? { agentDriver: seed.agentDriver } : {}),
            repository,
          })
        ).warmKey,
      buildSnapshots: async () => [],
      seal: async (operation) => {
        const resource =
          operation.state.kind === "ready" ? operation.state.allocation.resource : null;
        if (resource?.provider !== "namespace" || "engine" in resource)
          throw new Error("The spare build is not a ready Namespace Devbox.");
        await (
          await resolveNamespace()
        ).runtime.seal(operation, resource, await manifests.load(operation.request.requestId));
      },
      capture: async (operation) => ({ requestId: operation.request.requestId }),
      deleteSnapshot: async () => "missing",
      taken: async (requestId) => (await spareClaims.holder(requestId)) !== null,
      owns: (requestId) =>
        settleSpare(spareClaims, requestId, Date.now(), {
          claimant: async (chat, spare) => {
            if (!isProvisionRequestId(chat)) return "gone";
            const manifest = await manifests.load(chat).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (!manifest) return "pending";
            const { request } = manifest;
            // A retry of a freeze that failed after its claim may have frozen elsewhere.
            if (request.provider !== "namespace" || request.devboxName !== `t3-${spare}`)
              return "gone";
            // A cancel disposes the Devbox only once the request issued its
            // allocation. Before that, and after it ended, nobody else would.
            const { state } = await runLogged(store.accept(request));
            if (state.kind === "intent") return "pending";
            return state.kind === "disposed" ? "gone" : "owner";
          },
          release: async (spare) => {
            const operation = await runLogged(store.get(spare));
            if (operation.state.kind === "ready")
              await runLogged(
                store.advance(operation, {
                  kind: "disposed",
                  reason: "A chat claimed this spare, and its machine is that chat's now.",
                }),
              );
          },
        }),
    });
    const provisionControl = makeProvisionControl(
      store,
      provisioning,
      {
        freeze: async (input) => {
          const policy = warmBasePolicy(
            (await requireManager()).config.provisioning?.warmBaseRefreshHours,
          );
          const manifest = await freeze(
            input,
            async (repository, key) =>
              selectWarmTemplate(
                // An unreadable record costs this chat its warm start, never the chat.
                await warmStore.read(repository).catch(() => null),
                key,
                Date.now(),
                policy,
                warmBases.failedBases(),
              ),
            {
              select: async (repository, key) =>
                selectSpare(
                  await spareStore.read(repository).catch(() => null),
                  key,
                  Date.now(),
                  policy,
                  spares.failedBases(),
                ),
              claim: (spare, chat) => spareClaims.take(spare, chat, Date.now()),
            },
          );
          // A chat that had to start cold asks for a base, on the account it
          // routed to. One that started warm keeps its base in use.
          const { request } = manifest;
          if (manifest.warmKey && manifest.input.repository) {
            const bases = request.provider === "e2b" ? warmBases : spares;
            if (request.provider === "e2b" ? request.strategy === "direct" : request.devboxName)
              bases.used(manifest.input.repository);
            else
              bases.want(manifest.input.repository, {
                providerInstanceId: request.providerInstanceId,
                ...(request.agentDriver ? { agentDriver: request.agentDriver } : {}),
              });
          }
          return manifest;
        },
        load: manifests.load,
        attach: async (operation, manifest, recordedProxy, record) => {
          const manager = await resolve();
          if (!manager || operation.state.kind !== "ready") throw new Error("No ready runtime");
          const resource = operation.state.allocation.resource;
          if (resource.provider === "namespace") {
            const namespace = await resolveNamespace();
            return "engine" in resource
              ? namespace.mac.attach(operation, manifest, recordedProxy, record)
              : namespace.runtime.attach(operation, resource, manifest, recordedProxy, record);
          }
          return makeE2bProvisionRuntime(
            { apiKey: manager.config.e2bApiKey },
            logE2bResumeRetry,
          ).attach(operation, resource.sandboxId, manifest, record);
        },
        touch: async (operation) => {
          const manager = await resolve();
          if (!manager || operation.state.kind !== "ready") throw new Error("No ready runtime");
          const resource = operation.state.allocation.resource;
          if (resource.provider === "namespace") {
            const namespace = await resolveNamespace();
            return "engine" in resource
              ? namespace.mac.touch(operation)
              : namespace.runtime.touch(operation, resource);
          }
          return makeE2bProvisionRuntime(
            { apiKey: manager.config.e2bApiKey },
            logE2bResumeRetry,
          ).touch(operation, resource.sandboxId);
        },
        pinnedRuntime: async (provider) => {
          const manager = await resolve();
          return manager ? configuredRuntimeArtifact(manager.config, provider) : null;
        },
        setRuntime: manifests.setRuntime,
        prepare: ports.prepare,
        holdBox: async (sandboxId) => {
          const manager = await resolve();
          return manager ? manager.holdBox(sandboxId) : () => {};
        },
        deliverFirstTurn: async (remote, chat) => {
          const instances = deriveProviderInstanceConfigMap(await runLogged(settings.getSettings));
          return deliverFirstTurn(remote, chat, (instanceId) => instances[instanceId]?.driver);
        },
        readFirstTurn: manifests.readFirstTurn,
        forgetFirstTurn: manifests.forgetFirstTurn,
        listFirstTurns: manifests.listFirstTurns,
      },
      leaseRegistry,
    );
    const run = <A>(
      fn: (service: NonNullable<Awaited<ReturnType<typeof resolve>>>) => Promise<A>,
      absent: A,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const service = await resolve();
          return service ? fn(service) : absent;
        },
        catch: () =>
          new EnvironmentControlError({
            message: "Cloud controls are unavailable. Check the manager's private configuration.",
          }),
      });
    const cancelProvision = Effect.fn("EnvironmentControl.cancelProvision")(function* (
      requestId: ProvisionRequestId,
    ): Effect.fn.Return<EnvironmentProvisionDisposeResult, EnvironmentControlError> {
      const lease = yield* Effect.promise(() =>
        leaseRegistry.findById(requestId).catch(() => null),
      );
      if (lease?.state === "active" && lease.remoteAccess)
        yield* Effect.promise(() => pullUsage(lease).catch(() => undefined));
      const operation = yield* provisioning.cancel(requestId).pipe(
        Effect.mapError(
          () =>
            new EnvironmentControlError({
              message: "Cloud cleanup could not be reconciled. Retry the same request.",
            }),
        ),
      );
      if (operation.state.kind !== "disposed")
        return {
          kind: "refused",
          reason: "unknown",
          message:
            operation.state.kind === "cancel_requested"
              ? (operation.state.lastError ?? "Cleanup is still pending.")
              : "Cleanup is still pending.",
        };
      yield* Effect.tryPromise({
        try: () => leaseRegistry.markDisposed(requestId),
        catch: () =>
          new EnvironmentControlError({ message: "Cleanup receipt could not be saved." }),
      });
      return { kind: "disposed" };
    });
    /**
     * Removing a chat's ready box puts it to sleep, restorable for a grace period, since a sleeping
     * box costs little and a deleted one is gone for good. Any other box is deleted at once: one
     * still provisioning, one no chat owns, one whose chat never ran on it, or a Devbox, whose
     * disk bills while it sleeps. A failed read refuses rather than deleting.
     */
    const removeProvision = Effect.fn("EnvironmentControl.removeProvision")(function* (
      requestId: ProvisionRequestId,
    ): Effect.fn.Return<EnvironmentProvisionDisposeResult, EnvironmentControlError> {
      const lease = yield* Effect.tryPromise({
        try: () => leaseRegistry.findById(requestId),
        catch: () => new EnvironmentControlError({ message: "Cloud lease could not be loaded." }),
      });
      if (lease && keepsRemovedBox(lease)) {
        const operation = yield* store
          .get(requestId)
          .pipe(
            Effect.mapError(
              () => new EnvironmentControlError({ message: "Cloud request could not be loaded." }),
            ),
          );
        if (operation.state.kind !== "ready" || boxMachine(operation.request) === "devbox")
          return yield* cancelProvision(requestId);
        const removed = yield* run<
          EnvironmentProvisionDisposeResult | { readonly kind: "missing" }
        >((service) => service.remove(lease.leaseId), {
          kind: "refused",
          reason: "unconfigured",
          message: "This install has no cloud provisioning configuration.",
        });
        if (removed.kind !== "missing") return removed;
      }
      return yield* cancelProvision(requestId);
    });
    /** Deletes for good each removed box whose grace has ended; a failed one is tried next pass. */
    const purgeRemovedBoxes = async () => {
      for (const lease of await leaseRegistry.purgeable()) {
        if (!isProvisionRequestId(lease.leaseId)) continue;
        const purged = await runLogged(
          cancelProvision(lease.leaseId).pipe(
            Effect.catch((error) =>
              Effect.succeed({ kind: "refused" as const, message: error.message }),
            ),
          ),
        );
        await runLogged(
          purged.kind === "disposed"
            ? Effect.logInfo("removed cloud box deleted", { leaseId: lease.leaseId })
            : Effect.logWarning("removed cloud box could not be deleted yet", {
                leaseId: lease.leaseId,
                cause: purged.message,
              }),
        );
      }
    };
    const cloudMachinesAfterDays = settings.getSettings.pipe(
      Effect.map((current) => current.storageCleanup.cloudMachinesAfterDays),
    );
    const cleanupCandidate = async (lease: ProvisionedLease): Promise<CleanupCandidate> => ({
      lease,
      thread: (await chatStore.read(lease.leaseId))?.thread ?? null,
    });
    /** The Devbox a provisioned lease runs on, while its provision is ready; null otherwise. */
    const readyDevbox = async (leaseId: string) => {
      if (!isProvisionRequestId(leaseId) || importedLeases.has(leaseId)) return null;
      const operation = await Effect.runPromise(store.get(leaseId)).catch(() => null);
      const resource =
        operation?.state.kind === "ready" ? operation.state.allocation.resource : null;
      if (!operation || resource?.provider !== "namespace" || "engine" in resource) return null;
      return { operation, resource };
    };
    const logCleanup =
      (level: "info" | "warn") => (message: string, fields: Record<string, unknown>) =>
        void runLogged(
          (level === "info" ? Effect.logInfo(message) : Effect.logWarning(message)).pipe(
            Effect.annotateLogs(fields),
          ),
        );
    /**
     * Removes paused Devboxes past their cleanup time, through the same cancel a user's delete
     * takes. Their work is pushed with the configured GitHub token, which reaches the guest only
     * on the backup script's stdin. Each step resolves the current service, so the sweep takes
     * the same per-box lock a client's resume does.
     */
    const cleanUpPausedBoxes = createCleanupSweep({
      now: () => Date.now(),
      afterDays: () => runLogged(cloudMachinesAfterDays),
      candidates: async () => {
        const candidates: Array<CleanupCandidate> = [];
        for (const lease of await leaseRegistry.paused())
          if (lease.namespaceResource && (await readyDevbox(lease.leaseId)))
            candidates.push(await cleanupCandidate(lease));
        return candidates;
      },
      read: async (leaseId) => {
        const lease = await leaseRegistry.findById(leaseId);
        return lease ? cleanupCandidate(lease) : null;
      },
      holdBox: async (sandboxId) => (await resolve())?.holdBox(sandboxId, "clean") ?? null,
      beginRemoval: async (sandboxId) => (await resolve())?.beginRemoval(sandboxId),
      backUpWork: async (lease) => {
        const token = (await resolve())?.config.provisioning?.githubToken;
        const devbox = await readyDevbox(lease.leaseId);
        if (!devbox) throw new Error("The cloud box has no ready Devbox.");
        const manifest = await manifests.load(devbox.operation.request.requestId);
        return (await resolveNamespace()).runtime.backUpWork(
          devbox.operation,
          devbox.resource,
          manifest,
          {
            branch: lease.leaseId,
            target: workTarget({
              originIsPrivate: await repositoryIsPrivate(
                devbox.operation.request.repository,
                token,
              ),
              token,
              bundlePath: undefined,
            }),
          },
        );
      },
      setKeep: (leaseId, keep) => leaseRegistry.setKeep(leaseId, keep),
      sleep: async (lease) => {
        const service = await resolve();
        if (!service) throw new Error("The cloud lease manager is unavailable.");
        await service.sleepBox(lease);
      },
      dispose: async (leaseId) =>
        isProvisionRequestId(leaseId) &&
        (await runLogged(cancelProvision(leaseId))).kind === "disposed",
      log: logCleanup("info"),
      warn: logCleanup("warn"),
    });
    yield* Effect.gen(function* () {
      const service = yield* Effect.promise(resolve);
      if (!service) return;
      yield* runLeaseUpkeep({
        reapExpiredLeases: () => service.reapExpiredLeases(),
        syncLeaseUsage: () => service.syncLeaseUsage(),
        upkeepCloudChats: () => service.upkeepCloudChats(),
        cleanUpBoxes: async () => {
          await purgeRemovedBoxes();
          await cleanUpPausedBoxes();
        },
        reconcileProvisions: provisioning.reconcile,
        settleChats: provisionControl.settleChats,
        boxUsage,
      });
    }).pipe(Effect.forkScoped);
    yield* Effect.tryPromise(async () => {
      const manager = await resolve();
      if (!manager) return;
      const policy = warmBasePolicy(manager.config.provisioning?.warmBaseRefreshHours);
      // Side by side: a tick waits on its builds, and a Mac takes many minutes.
      // Both finish before the next round starts, even when one fails.
      const ticks = await Promise.allSettled([warmBases.tick(policy), spares.tick(policy)]);
      for (const tick of ticks) if (tick.status === "rejected") throw tick.reason;
    }).pipe(
      Effect.ignore({ log: "Warn", message: "warm bases could not be kept up" }),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped,
    );
    // A server that runs agents itself reads `source` as an operator keeps it.
    if (!localAgentRuns)
      yield* Effect.tryPromise(resolve).pipe(
        Effect.flatMap((manager) =>
          Effect.forEach(
            (manager?.config.provisioning?.skills ?? []).flatMap(({ source, url }) =>
              url ? [{ source, url }] : [],
            ),
            (bundle) =>
              Effect.tryPromise(() => refreshSkillBundle(bundle)).pipe(
                Effect.flatMap((result) =>
                  result === "updated" ? Effect.logInfo("skill bundle updated") : Effect.void,
                ),
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("skill bundle could not be refreshed", error).pipe(
                    Effect.as(false),
                  ),
                ),
                Effect.annotateLogs({ source: bundle.source }),
              ),
          ),
        ),
        Effect.flatMap((refreshed) =>
          refreshed.every(Boolean)
            ? Effect.void
            : Effect.fail(
                new EnvironmentControlError({ message: "A skill bundle could not be refreshed." }),
              ),
        ),
        // Until a bundle's first download lands, new chats start without it,
        // so a failed refresh retries within minutes before waiting the hour.
        Effect.retry({ schedule: Schedule.exponential("1 minute"), times: 4 }),
        Effect.ignore({ log: "Warn", message: "skill bundles could not be refreshed" }),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.forkScoped,
      );
    /**
     * Moves an idle box the reaper is about to put to sleep onto the pinned build. A wake or
     * another upgrade holding the box is waited out briefly; past that the next sweep decides.
     */
    const upgradeIdleBox = Effect.fn("EnvironmentControl.upgradeIdleBox")(
      function* (lease: ProvisionedLease) {
        const operation = yield* store.get(ProvisionRequestId.make(lease.leaseId));
        if (operation.state.kind !== "ready") return;
        const environmentId = operation.state.readiness.environmentId;
        const startedAt = yield* Clock.currentTimeMillis;
        const upgraded = yield* provisionControl
          .upgrade({ leaseId: lease.leaseId, sandboxId: lease.sandboxId, environmentId })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds").pipe(Schedule.upTo({ duration: "1 minute" })),
              while: (result) => result.kind === "refused" && result.reason === "busy",
            }),
            wakeAhead.track(environmentId, boxMachine(operation.request), "updating"),
          );
        yield* Effect.logInfo("idle cloud workspace upgraded before sleeping", {
          leaseId: lease.leaseId,
          result: upgraded.kind === "refused" ? `refused: ${upgraded.message}` : upgraded.kind,
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        });
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("idle cloud workspace could not be upgraded", { cause }),
      ),
    );
    /** The login a box is handed for one of this host's accounts. */
    const switchTarget = async (profile: ProvisioningProviderProfile): Promise<SwitchTarget> => {
      const named = {
        instanceId: profile.instanceId,
        name: profile.displayName ?? profile.instanceId,
        displayName: profile.displayName,
        accountEmail: profile.accountEmail,
      };
      if (profile.credential.kind === "file") {
        const { source, destination } = profile.credential;
        const login = await homeFileData(destination, () => NodeFSP.readFile(source));
        return {
          ...named,
          credential: { kind: "file", contentsBase64: login.toString("base64") },
        };
      }
      const names: ReadonlyArray<string> = credentialVariables[profile.kind];
      const [first, ...rest] = profile.environment.flatMap(({ name, value }) =>
        names.includes(name) && value.trim() ? [{ name, value: value.trim() }] : [],
      );
      if (!first) throw new Error("The account has no credential to hand a cloud machine.");
      return { ...named, credential: { kind: "environment", variables: [first, ...rest] } };
    };
    const accountPorts: AccountSwitchPorts = {
      readShell: async (lease) => {
        await serveProxy(lease);
        return readLeaseShell(lease);
      },
      accountDriver: async (instanceId) =>
        deriveProviderInstanceConfigMap(await runLogged(settings.getSettings))[
          ProviderInstanceId.make(instanceId)
        ]?.driver,
      pickAccount: async (driver, exclude) => {
        const manager = await requireManager();
        const profile = await resolveAccounts((current) =>
          Effect.all({
            providers: providerRegistry.getProviders,
            now: Clock.currentTimeMillis,
            load: readAccountLoad(leaseRegistry, sql, store),
          }).pipe(
            Effect.flatMap((usage) =>
              resolveSwitchProfile(
                current,
                { driver, exclude },
                manager.config.provisioning?.claudeOAuthTokens,
                usage,
                {
                  localAgentRuns,
                  secretsDir,
                  refresh: (instanceId) =>
                    providerRegistry.refreshInstance(instanceId).pipe(Effect.asVoid),
                },
              ),
            ),
          ),
        );
        return Option.isSome(profile) ? switchTarget(profile.value) : null;
      },
      sendSwitch: async (lease, input) => {
        if (!lease.remoteAccess) throw new Error("The cloud machine has no remote access.");
        await serveProxy(lease);
        return sendAccountSwitch(lease.remoteAccess, input);
      },
    };
    const accountRotation = makeAccountRotation({
      ports: accountPorts,
      leases: leaseRegistry,
      enabled: async () => (await runLogged(settings.getSettings)).autoSwitchCloudAccounts,
      holdBox: async (sandboxId) => (await resolve())?.holdBox(sandboxId) ?? null,
      report: (lease, outcome) =>
        void runLogged(
          outcome.kind === "failed"
            ? Effect.logWarning("cloud chat could not switch accounts", {
                leaseId: lease.leaseId,
                cause: outcome.cause,
              })
            : Effect.logInfo("cloud chat switch at a usage limit answered", {
                leaseId: lease.leaseId,
                result:
                  outcome.result.kind === "switched"
                    ? "switched"
                    : `refused: ${outcome.result.reason}`,
                continued: outcome.result.kind === "switched" && outcome.result.continued,
              }),
        ),
    });
    const resumeWorkspace = Effect.fn("EnvironmentControl.resume")(function* (
      input: EnvironmentProvisionResumeInput,
    ) {
      const workspace = (yield* listProvisionedEnvironments(sql)).find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      if (!workspace) {
        yield* Effect.logInfo("cloud workspace resume refused", {
          environmentId: input.environmentId,
          reason: "not-provisioned",
        });
        return {
          kind: "refused" as const,
          reason: "not-provisioned" as const,
          message: "This machine has no workspace for that environment.",
        };
      }
      const machine = workspace.machine ?? "sandbox";
      // A resume can run for many minutes (a Mac boot, a stopped Devbox), and its first sign
      // otherwise is the machine it creates, so each one is logged as it starts and ends.
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("cloud workspace resume started", {
        environmentId: input.environmentId,
        leaseId: workspace.leaseId,
        lifecycle: workspace.lifecycle,
      });
      const result = yield* run<EnvironmentProvisionResumeResult>(
        (service) => service.resume(workspace),
        {
          kind: "refused",
          reason: "unknown",
          message: "This install has no provisioning template configured.",
        },
      ).pipe(wakeAhead.track(workspace.environmentId, machine, "waking"));
      yield* Effect.logInfo("cloud workspace resume answered", {
        leaseId: workspace.leaseId,
        result: result.kind === "resumed" ? "resumed" : `refused: ${result.cause ?? result.reason}`,
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      });
      yield* wakeAhead.settle(workspace.environmentId, result);
      const upgrade = provisionControl.upgrade({
        leaseId: workspace.leaseId,
        sandboxId: workspace.sandboxId,
        environmentId: input.environmentId,
      });
      if (result.kind === "resumed") {
        const guestProtocol = yield* Effect.promise(async () => {
          const lease = await leaseRegistry.findById(workspace.leaseId).catch(() => null);
          if (!lease?.remoteAccess) return null;
          await serveProxy(lease);
          return readGuestProtocol(lease.remoteAccess.origin);
        });
        const mustUpgrade = wakeNeedsUpgrade(guestProtocol, workspace.lifecycle === "paused");
        yield* Effect.logInfo("cloud workspace build checked on resume", {
          leaseId: workspace.leaseId,
          guestProtocol,
          upgrade: mustUpgrade ? "before connecting" : "none before connecting",
        });
        if (!mustUpgrade) return result;
        return yield* upgradeAfterResume(upgrade).pipe(
          wakeAhead.track(workspace.environmentId, machine, "updating"),
          Effect.tap((upgraded) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.logInfo("cloud workspace upgrade on resume answered", {
                leaseId: workspace.leaseId,
                result: upgraded.kind === "refused" ? `refused: ${upgraded.message}` : "resumed",
                durationMs: now - startedAt,
              }),
            ),
          ),
        );
      }
      const recovered = yield* recoverRefusedResume(result, upgrade).pipe(
        wakeAhead.track(workspace.environmentId, machine, "updating"),
      );
      if (recovered.kind === "resumed")
        yield* Effect.logInfo("cloud workspace recovered by upgrade", {
          leaseId: workspace.leaseId,
        });
      return recovered;
    });
    const wakeAhead = makeWakeAhead({
      list: listProvisionedEnvironments(sql, [], [], []),
      resume: (box) =>
        resumeWorkspace({ environmentId: box.environmentId }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              kind: "refused" as const,
              reason: "unknown" as const,
              message: error.message,
            }),
          ),
        ),
      renew: (box) => provisionControl.touch({ leaseId: box.leaseId }, "host"),
      scope: yield* Effect.scope,
    });
    // Unsettled chats are woken again after a refusal and renewed while the user stays.
    yield* wakeAhead.pass.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(30))),
      Effect.forkScoped,
    );
    return {
      namespaceProxyOrigin: (leaseId) =>
        Effect.tryPromise({
          try: async () => {
            const lease = await leaseRegistry.findById(leaseId);
            if (
              !lease ||
              (lease.state !== "active" && lease.state !== "paused") ||
              !lease.namespaceProxy
            )
              return null;
            await serveProxy(lease);
            return lease.namespaceProxy.proxyOrigin;
          },
          catch: () => new EnvironmentControlError({ message: "Cloud lease could not be loaded." }),
        }),
      list: run((service) => service.list(), []),
      controlConfig: run<EnvironmentControlConfig | null>(async (service) => service.config, null),
      provisionProviders: run(async (service) => provisionProviders(service.config), []),
      provisionedSkills: localAgentRuns
        ? Effect.succeed(undefined)
        : run(async (service) => {
            const bundles = service.config.provisioning?.skills ?? [];
            if (bundles.length === 0) return undefined;
            // A bundle directory's mtime moves when a skill is added or
            // removed, so the list follows the bundles without a rescan per
            // request. The service itself is replaced when the config changes.
            const mtimes = (
              await Promise.all(
                bundles.map((bundle) =>
                  NodeFSP.stat(bundle.source).then(
                    (stats) => stats.mtimeMs,
                    () => null,
                  ),
                ),
              )
            ).join(",");
            if (scannedSkills?.service !== service || scannedSkills.mtimes !== mtimes)
              scannedSkills = { service, mtimes, skills: readProvisionedSkills(bundles) };
            return scannedSkills.skills;
          }, undefined).pipe(Effect.orElseSucceed(() => undefined)),
      listProvisioned: (knownEnvironmentIds, addresses, chats) =>
        cloudMachinesAfterDays.pipe(
          Effect.orElseSucceed(() => null),
          Effect.flatMap((afterDays) =>
            listProvisionedEnvironments(
              sql,
              knownEnvironmentIds,
              addresses,
              chats,
              afterDays,
              true,
            ),
          ),
          // A chat started since the last sweep has no card yet, so it is read in the background
          // and the client's next list carries it.
          Effect.tap(() =>
            chats === undefined
              ? Effect.void
              : Effect.sync(() => {
                  void resolve()
                    .then((service) => service?.readNewChats())
                    .catch(() => undefined);
                }),
          ),
        ),
      provision: provisionControl.provision,
      attach: provisionControl.attach,
      dispose: Effect.fn("EnvironmentControl.dispose")(function* (
        input: EnvironmentProvisionDisposeInput,
      ) {
        if ("requestId" in input) return yield* removeProvision(input.requestId);
        const lease = yield* Effect.tryPromise({
          try: () => leaseRegistry.findBySandbox(input.sandboxId),
          catch: () => new EnvironmentControlError({ message: "Cloud lease could not be loaded." }),
        });
        if (lease && !importedLeases.has(lease.leaseId) && isProvisionRequestId(lease.leaseId)) {
          if (input.leaseId && input.leaseId !== lease.leaseId)
            return {
              kind: "refused" as const,
              reason: "unknown" as const,
              message: "The lease does not match this environment.",
            };
          return yield* removeProvision(lease.leaseId);
        }
        return yield* run<EnvironmentProvisionDisposeResult>((service) => service.dispose(input), {
          kind: "refused",
          reason: "unconfigured",
          message: "This install has no cloud provisioning configuration.",
        });
      }),
      pause: (input) =>
        run<EnvironmentProvisionPauseResult>((service) => service.pause(input), {
          kind: "refused" as const,
          reason: "unknown" as const,
          message: "This install has no provisioning template configured.",
        }),
      claim: provisionControl.claim,
      resume: resumeWorkspace,
      restore: (input) =>
        Effect.tryPromise({
          try: async (): Promise<EnvironmentProvisionRestoreResult> =>
            (await leaseRegistry.restore(input.leaseId))
              ? { kind: "restored" }
              : {
                  kind: "refused",
                  reason: "unknown",
                  message: "This cloud machine can no longer be restored.",
                },
          catch: () =>
            new EnvironmentControlError({ message: "Cloud lease could not be updated." }),
        }),
      upgrade: provisionControl.upgrade,
      switchAccount: Effect.fn("EnvironmentControl.switchAccount")(function* (
        input: EnvironmentProvisionSwitchAccountInput,
      ): Effect.fn.Return<EnvironmentProvisionSwitchAccountResult, EnvironmentControlError> {
        const workspace = (yield* listProvisionedEnvironments(sql)).find(
          (candidate) => candidate.environmentId === input.environmentId,
        );
        const lease = workspace
          ? yield* Effect.promise(() => leaseRegistry.findById(workspace.leaseId))
          : null;
        if (!lease)
          return {
            kind: "refused",
            reason: "unknown",
            message: "This host has no cloud machine for that environment.",
          };
        const result = yield* Effect.promise(() =>
          accountRotation.switchAccount(lease, input.threadId).then(
            (answer) => ({ answer }),
            (cause: unknown) => ({ cause }),
          ),
        );
        if ("cause" in result) {
          yield* Effect.logWarning("cloud machine could not switch accounts", {
            leaseId: lease.leaseId,
            cause: result.cause,
          });
          return yield* new EnvironmentControlError({
            message: "The cloud machine could not switch accounts. Retry shortly.",
          });
        }
        return (
          result.answer ?? {
            kind: "refused",
            reason: "unknown",
            message: "This cloud machine could not be found.",
          }
        );
      }),
      presence: (input) => wakeAhead.presence(input.present),
      touch: (input) =>
        importedLeases.has(input.leaseId)
          ? run<EnvironmentProvisionTouchResult>(
              async (service) => {
                const imported = importedLeases.get(input.leaseId)!;
                const current = await leaseRegistry.findBySandbox(imported.sandboxId);
                if (current?.state !== "active" || current.owner === null)
                  return {
                    kind: "refused",
                    reason: "unknown",
                    message: "This environment has no active claimed lease.",
                  };
                if (current.namespaceResource)
                  await (
                    await resolveNamespace()
                  ).runtime.retainImportedLease(current.namespaceResource);
                else
                  await makeE2bProvisionRuntime({
                    apiKey: service.config.e2bApiKey,
                  }).retainImportedLease(current);
                return service.touch(input);
              },
              {
                kind: "refused",
                reason: "unknown",
                message: "The cloud lease manager is unavailable.",
              },
            )
          : provisionControl.touch(input),
      keep: (input) =>
        Effect.tryPromise({
          try: async (): Promise<EnvironmentProvisionKeepResult> => {
            const lease = await leaseRegistry.findById(input.requestId);
            if (!lease || lease.state === "disposed")
              return {
                kind: "refused",
                reason: "unknown",
                message: "This cloud machine could not be found.",
              };
            if (input.keep) await leaseRegistry.setKeep(lease.leaseId, "user");
            else if (lease.keep === "user") await leaseRegistry.setKeep(lease.leaseId, null);
            return { kind: "updated" };
          },
          catch: () =>
            new EnvironmentControlError({ message: "Cloud lease could not be updated." }),
        }),
      start: (id) => run((service) => service.start(id), refused("unknown")),
      stop: (id) => run((service) => service.stop(id), refused("unknown")),
    };
  }),
).pipe(Layer.provide(ProvisionOperationStore.layer), Layer.provide(BoxUsageStore.layer));
