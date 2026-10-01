// @effect-diagnostics globalDate:off - provider control crosses a Promise boundary.
// @effect-diagnostics nodeBuiltinImport:off - provider control resolves state in a Node filesystem boundary.
import { ProvisionRetentionError } from "./retention.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  EnvironmentControlError,
  ProvisionRequestId,
  type ComputeState,
  type EnvironmentId,
  type EnvironmentControlResult,
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
  type EnvironmentProvisionUpgradeInput,
  type EnvironmentProvisionUpgradeResult,
  type ManagedEnvironment,
  type DiscoveredProvisionedEnvironment,
  type SavedEnvironmentAddress,
  type ProvisionProvider,
  type ServerProvisionedSkills,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ALL_TRAFFIC } from "e2b";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderPorts, ProvisionProviderError } from "./Provisioning.ts";
import {
  configuredRuntimeArtifact,
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
import { listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { makeProvisionControl } from "./ProvisionControl.ts";
import { makeNamespaceAllocationPorts } from "./namespaceAllocation.ts";
import {
  makeNamespaceAccountSession,
  makeNamespaceProvisionRuntime,
} from "./NamespaceProvisionRuntime.ts";
import { makeE2bAllocationPorts } from "./E2bProvisionAllocation.ts";
import { makeE2bProvisionRuntime, makeProvisionResolution } from "./E2bProvisionRuntime.ts";
import type { E2bResumeRetry } from "./e2bResume.ts";
import { provisionFailureMessage } from "./provisionFailure.ts";
import { logProvisionPhases, type ProvisionPhase } from "./provisionTiming.ts";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import { readAccountLoad } from "./accountLoad.ts";
import { readProvisionedSkills } from "./provisionedSkills.ts";
import { ProvisionRefused, resolveProvisioningProfiles } from "./ProvisioningProviderProfile.ts";
import * as ServerConfig from "../config.ts";
import {
  readConfig,
  resolveControlConfigPath,
  type EnvironmentControlConfig,
  type ManagedTarget,
} from "./config.ts";
import { createCloudDriver, ProvisionedSandboxMissing, type CloudDriver } from "./driver.ts";
import {
  createProvisionedLeaseRegistry,
  decodeLegacyLeases,
  type ProvisionedLease,
  type ProvisionedLeaseRegistry,
} from "./ProvisionedLeaseRegistry.ts";
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import { pullLeaseUsage, readLeaseActivity, type LeaseActivity } from "./leaseActivity.ts";
import { runLeaseUpkeep } from "./leaseUpkeep.ts";
import { BoxUsageStore } from "../usage/boxUsage.ts";

const isProvisionRequestId = Schema.is(ProvisionRequestId);

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

export function createEnvironmentControl(
  targets: ReadonlyArray<ManagedTarget>,
  driver: CloudDriver,
  leaseRegistry?: ProvisionedLeaseRegistry,
  activity: (lease: ProvisionedLease) => Promise<LeaseActivity> = readLeaseActivity,
  pullUsage: (lease: ProvisionedLease) => Promise<void> = async () => {},
) {
  const pending = new Map<
    EnvironmentId,
    { action: "start" | "stop"; promise: Promise<EnvironmentControlResult> }
  >();
  const leaseOperations = new Map<
    string,
    | { action: "pause" | "dispose" | "reap" | "renew" }
    | { action: "resume"; ownerKey: string; promise: Promise<EnvironmentProvisionResumeResult> }
  >();
  let bootstrapping: Promise<void> | undefined;
  /** The last activity each awake lease settled on, so a finished turn pulls once. */
  const settledActivity = new Map<string, "busy" | "idle">();
  // A stopped box's transcripts are unreachable, so its usage is pulled first.
  // A failed pull never blocks the stop.
  const pullBeforeStop = async (lease: ProvisionedLease): Promise<void> => {
    if (lease.state !== "active" || !lease.remoteAccess) return;
    await pullUsage(lease).catch(() => undefined);
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
    // Heartbeat expiry is a liveness transition only. Keep the provider
    // resource paused and reconnectable; disposal is explicit.
    for (const lease of await leaseRegistry.expired()) {
      if (only && !only.has(lease.leaseId)) continue;
      // A resume or renew in flight is working on this box. Stopping it under
      // them kills their commands, and a resume ends by renewing the lease.
      if (leaseOperations.has(lease.sandboxId)) continue;
      leaseOperations.set(lease.sandboxId, { action: "reap" });
      try {
        // An expired heartbeat means no client is watching, not that the agent
        // stopped. Only a machine confirmed busy stays awake; one that cannot be
        // read is paused, so a broken machine is never kept alive.
        if (
          lease.state === "active" &&
          (await activity(lease)) === "busy" &&
          (await leaseRegistry.touch(lease.leaseId))
        )
          continue;
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
        await pullBeforeStop(lease);
        const result = await driver.pause({
          sandboxId: current.sandboxId,
          ...(current.namespaceResource ? { namespaceResource: current.namespaceResource } : {}),
        });
        if (result === "missing") await leaseRegistry.markMissing(lease.leaseId);
        else await leaseRegistry.markPaused(lease.leaseId);
      } catch {
        // Keep the lease eligible for another pause attempt on the next sweep.
      } finally {
        leaseOperations.delete(lease.sandboxId);
      }
    }
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
        await pullBeforeStop(lease);
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
      } catch {
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
        const resumed = await driver.resume({
          leaseId: lease.leaseId,
          sandboxId: lease.sandboxId,
          environmentId: input.environmentId,
          providerInstanceId: lease.providerInstanceId,
          ...(lease.namespaceResource ? { namespaceResource: lease.namespaceResource } : {}),
          ...(lease.namespaceProxy ? { namespaceProxy: lease.namespaceProxy } : {}),
        });
        if (!(await leaseRegistry.markActive({ leaseId: lease.leaseId, ...resumed })))
          throw new Error("Lease could not be resumed");
        return { kind: "resumed" };
      })()
        .catch(async (cause): Promise<EnvironmentProvisionResumeResult> => {
          if (cause instanceof ProvisionedSandboxMissing)
            await leaseRegistry?.markMissing(input.leaseId);
          return {
            kind: "refused",
            reason: cause instanceof ProvisionedSandboxMissing ? "missing" : "unknown",
            message:
              cause instanceof ProvisionedSandboxMissing
                ? cause.message
                : "The workspace could not be reconnected. Retry shortly.",
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
    /**
     * Pulls each awake box's usage when its agent settles from busy to idle,
     * or the first time it is seen idle. A failed pull retries next sweep.
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
          const current = await activity(lease);
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
     * Also reports those of `knownEnvironmentIds` that were this host's boxes and are gone, and
     * those of `addresses` that dial such a box.
     */
    readonly listProvisioned: (
      knownEnvironmentIds?: ReadonlyArray<EnvironmentId>,
      addresses?: ReadonlyArray<SavedEnvironmentAddress>,
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
    readonly upgrade: (
      input: EnvironmentProvisionUpgradeInput,
    ) => Effect.Effect<EnvironmentProvisionUpgradeResult, EnvironmentControlError>;
  }
>()("t3/environmentControl/EnvironmentControl") {}

export const layer = Layer.effect(
  EnvironmentControl,
  Effect.gen(function* () {
    const { stateDir, localAgentRuns } = yield* ServerConfig.ServerConfig;
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
    const threadSessions = yield* ProjectionThreadSessionRepository;
    const profileContext = yield* Effect.context<Path.Path | FileSystem.FileSystem>();
    // Promise-side provider code logs through the server's logger, not the default one.
    const runLogged = Effect.runPromiseWith(yield* Effect.context<never>());
    const logE2bResumeRetry = (retry: E2bResumeRetry) =>
      void runLogged(
        Effect.logWarning("E2B could not resume a cloud workspace yet; retrying", retry),
      );
    const pullUsage = (lease: ProvisionedLease) =>
      runLogged(
        pullLeaseUsage(boxUsage, lease).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("cloud box usage could not be pulled", {
              leaseId: lease.leaseId,
              cause,
            }),
          ),
        ),
      );
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
              // A box this manager provisioned resumes through the runtime that
              // prepared it, and fetches its followed branch so the thread sees
              // what was pushed while it slept. Imported leases keep the legacy
              // runner.
              resume: async (input) => {
                try {
                  if (importedLeases.has(input.leaseId) || !isProvisionRequestId(input.leaseId))
                    return await cloud.resume(input);
                  if (input.namespaceResource)
                    return await resumeProvisionedNamespace(input.leaseId, input.namespaceProxy);
                  const resumed = await cloud.resume(input);
                  // Best effort: the sandbox is awake and resumed either way.
                  await refreshProvisionedE2b(input.leaseId, config.e2bApiKey).then(
                    ({ refreshError }) => runLogged(logRefresh(input.leaseId, refreshError)),
                    (cause) => runLogged(logRefresh(input.leaseId, String(cause))),
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
            readLeaseActivity,
            pullUsage,
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
      const { runtime } = await resolveNamespace();
      const { namespaceProxy, refreshError } = await runtime.resume(
        operation,
        operation.state.allocation.resource,
        manifest,
        recordedProxy,
        build,
      );
      await runLogged(logRefresh(requestId, refreshError));
      return { namespaceProxy };
    };
    const refreshProvisionedE2b = async (requestId: ProvisionRequestId, apiKey: string) => {
      const operation = await Effect.runPromise(store.get(requestId));
      if (
        operation.state.kind !== "ready" ||
        operation.state.allocation.resource.provider !== "e2b"
      )
        throw new Error("No ready E2B runtime");
      return makeE2bProvisionRuntime({ apiKey }, logE2bResumeRetry).refresh(
        operation,
        operation.state.allocation.resource.sandboxId,
        await manifests.load(requestId),
      );
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
    const ports: ProvisionProviderPorts["Service"] = {
      create: (operation) =>
        Effect.flatMap(provider(operation), ({ allocator, namespace }) =>
          (namespace?.allocator ?? allocator).create(operation),
        ),
      recoverCreate: (operation) =>
        Effect.flatMap(provider(operation), ({ allocator, namespace }) =>
          (namespace?.allocator ?? allocator).recoverCreate(operation),
        ),
      fork: (operation, parent) =>
        Effect.flatMap(provider(operation), ({ allocator }) => allocator.fork(operation, parent)),
      recoverFork: (operation, parent) =>
        Effect.flatMap(provider(operation), ({ allocator }) =>
          allocator.recoverFork(operation, parent),
        ),
      dispose: (operation, resource) =>
        Effect.gen(function* () {
          const { runtime, namespace } = yield* provider(operation);
          if (resource.provider === "namespace")
            return yield* Effect.tryPromise({
              try: async () => {
                if (!namespace) throw new Error("Namespace unavailable");
                await namespace.runtime.dispose(operation, resource);
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
      Effect.provideService(ProvisionProviderPorts, ports),
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
              load: readAccountLoad(leaseRegistry, threadSessions),
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
        if (
          operation.state.kind !== "ready" ||
          operation.state.allocation.resource.provider !== "namespace"
        )
          throw new Error("The spare build is not a ready Namespace Mac.");
        await (
          await resolveNamespace()
        ).runtime.seal(
          operation,
          operation.state.allocation.resource,
          await manifests.load(operation.request.requestId),
        );
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
          if (resource.provider === "namespace")
            return (await resolveNamespace()).runtime.attach(
              operation,
              resource,
              manifest,
              recordedProxy,
              record,
            );
          return makeE2bProvisionRuntime(
            { apiKey: manager.config.e2bApiKey },
            logE2bResumeRetry,
          ).attach(operation, resource.sandboxId, manifest, record);
        },
        touch: async (operation) => {
          const manager = await resolve();
          if (!manager || operation.state.kind !== "ready") throw new Error("No ready runtime");
          const resource = operation.state.allocation.resource;
          if (resource.provider === "namespace")
            return (await resolveNamespace()).runtime.touch(operation, resource);
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
    yield* Effect.gen(function* () {
      const service = yield* Effect.promise(resolve);
      if (!service) return;
      yield* runLeaseUpkeep({
        reapExpiredLeases: () => service.reapExpiredLeases(),
        syncLeaseUsage: () => service.syncLeaseUsage(),
        reconcileProvisions: provisioning.reconcile,
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
            return lease.namespaceProxy.proxyOrigin;
          },
          catch: () => new EnvironmentControlError({ message: "Cloud lease could not be loaded." }),
        }),
      list: run((service) => service.list(), []),
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
      listProvisioned: (knownEnvironmentIds, addresses) =>
        listProvisionedEnvironments(sql, knownEnvironmentIds, addresses),
      provision: provisionControl.provision,
      attach: provisionControl.attach,
      dispose: Effect.fn("EnvironmentControl.dispose")(function* (
        input: EnvironmentProvisionDisposeInput,
      ) {
        if ("requestId" in input) return yield* cancelProvision(input.requestId);
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
          return yield* cancelProvision(lease.leaseId);
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
      resume: Effect.fn("EnvironmentControl.resume")(function* (
        input: EnvironmentProvisionResumeInput,
      ) {
        const workspace = (yield* listProvisionedEnvironments(sql)).find(
          (candidate) => candidate.environmentId === input.environmentId,
        );
        if (!workspace)
          return {
            kind: "refused" as const,
            reason: "not-provisioned" as const,
            message: "This machine has no workspace for that environment.",
          };
        return yield* run<EnvironmentProvisionResumeResult>(
          (service) => service.resume(workspace),
          {
            kind: "refused",
            reason: "unknown",
            message: "This install has no provisioning template configured.",
          },
        );
      }),
      upgrade: provisionControl.upgrade,
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
      start: (id) => run((service) => service.start(id), refused("unknown")),
      stop: (id) => run((service) => service.stop(id), refused("unknown")),
    };
  }),
).pipe(
  Layer.provide(ProvisionOperationStore.layer),
  Layer.provide(BoxUsageStore.layer),
  Layer.provide(ProjectionThreadSessionRepositoryLive),
);
