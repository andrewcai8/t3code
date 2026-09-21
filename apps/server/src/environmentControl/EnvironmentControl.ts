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
  type ManagedEnvironment,
  type DiscoveredProvisionedEnvironment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ALL_TRAFFIC } from "e2b";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderPorts, ProvisionProviderError } from "./Provisioning.ts";
import { makeProvisionPreparationStore } from "./ProvisionPreparation.ts";
import { listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { makeProvisionControl } from "./ProvisionControl.ts";
import { makeNamespaceAllocationPorts } from "./namespaceAllocation.ts";
import {
  makeNamespaceAccountSession,
  makeNamespaceProvisionRuntime,
} from "./NamespaceProvisionRuntime.ts";
import { makeE2bAllocationPorts } from "./E2bProvisionAllocation.ts";
import { makeE2bProvisionRuntime, makeProvisionResolution } from "./E2bProvisionRuntime.ts";
import { provisionFailureMessage } from "./provisionFailure.ts";
import { logProvisionPhases, type ProvisionPhase } from "./provisionTiming.ts";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProvisionRefused,
  resolveProvisioningProviderProfile,
} from "./ProvisioningProviderProfile.ts";
import * as ServerConfig from "../config.ts";
import {
  readConfig,
  resolveControlConfigPath,
  type ManagedTarget,
  type Provisioning as ProvisioningConfig,
} from "./config.ts";
import {
  createCloudDriver,
  ProvisionedSandboxMissing,
  type CloudDriver,
  type ProvisionRequest,
} from "./driver.ts";
import {
  createProvisionedLeaseRegistry,
  decodeLegacyLeases,
  type ProvisionedLease,
  type ProvisionedLeaseRegistry,
} from "./ProvisionedLeaseRegistry.ts";
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import { readLeaseActivity, type LeaseActivity } from "./leaseActivity.ts";

const isProvisionRequestId = Schema.is(ProvisionRequestId);
const isProvisionRefused = Schema.is(ProvisionRefused);

const LEASE_REAP_INTERVAL_MS = 5 * 60 * 1000;

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
      try {
        // beginRelease already moved this lease to `releasing`, so the
        // recheck confirms that and not the state it held before.
        const current = await leaseRegistry.findBySandbox(lease.sandboxId);
        if (
          !current ||
          current.state !== "releasing" ||
          current.expiresAt > new Date().toISOString()
        )
          continue;
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
          const knownMissing =
            (await leaseRegistry.findBySandbox(input.sandboxId))?.state === "missing";
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
    resume: (input: EnvironmentProvisionResumeInput): Promise<EnvironmentProvisionResumeResult> => {
      const ownerKey = JSON.stringify([input.leaseId, input.environmentId, input.threadId]);
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
          lease.owner?.environmentId !== input.environmentId ||
          lease.owner.threadId !== input.threadId ||
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
    claim: async (
      input: EnvironmentProvisionClaimInput,
    ): Promise<EnvironmentProvisionClaimResult> => {
      if (!leaseRegistry)
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox lease registry is unavailable.",
        };
      const lease = await leaseRegistry.claim({
        leaseId: input.leaseId,
        owner: { environmentId: input.environmentId, threadId: input.threadId },
      });
      return lease
        ? { kind: "claimed" }
        : {
            kind: "refused",
            reason: "unknown",
            message: "The cloud sandbox lease could not be claimed.",
          };
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
  };
}

export class EnvironmentControl extends Context.Service<
  EnvironmentControl,
  {
    readonly list: Effect.Effect<ReadonlyArray<ManagedEnvironment>, EnvironmentControlError>;
    readonly listProvisioned: Effect.Effect<
      ReadonlyArray<DiscoveredProvisionedEnvironment>,
      EnvironmentControlError
    >;
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
  }
>()("t3/environmentControl/EnvironmentControl") {}

export const layer = Layer.effect(
  EnvironmentControl,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
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
    const settings = yield* ServerSettingsService;
    const profileContext = yield* Effect.context<Path.Path | FileSystem.FileSystem>();
    const resolveProfile = async (
      request: ProvisionRequest,
      claudeOAuthTokens?: ProvisioningConfig["claudeOAuthTokens"],
    ) => {
      const result = await Effect.runPromiseWith(profileContext)(
        settings.getSettings.pipe(
          Effect.flatMap((current) =>
            resolveProvisioningProviderProfile(current, request, claudeOAuthTokens),
          ),
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
          const cloud = createCloudDriver(config, resolveProfile);
          const control = createEnvironmentControl(
            config.targets,
            {
              ...cloud,
              // A Mac this manager provisioned resumes through the runtime that
              // prepared it. Imported leases keep the legacy runner.
              resume: (input) =>
                input.namespaceResource &&
                !importedLeases.has(input.leaseId) &&
                isProvisionRequestId(input.leaseId)
                  ? resumeProvisionedNamespace(input.leaseId, input.namespaceProxy)
                  : cloud.resume(input),
            },
            leaseRegistry,
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
      const { runtime } = await resolveNamespace();
      return {
        namespaceProxy: await runtime.resume(
          operation,
          operation.state.allocation.resource,
          manifest,
          recordedProxy,
        ),
      };
    };
    const provider = (operation: ProvisionOperation) =>
      Effect.tryPromise(async () => {
        const manager = await resolve();
        if (!manager) throw new Error("Missing cloud configuration");
        const manifest = await manifests.load(operation.request.requestId);
        const connection = { apiKey: manager.config.e2bApiKey };
        return {
          manifest,
          namespace: operation.request.provider === "namespace" ? await resolveNamespace() : null,
          runtime: makeE2bProvisionRuntime(connection),
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
          const { runtime, manifest, namespace } = yield* provider(operation);
          const resource = allocation.resource;
          if (resource.provider === "namespace")
            return yield* Effect.tryPromise({
              try: async () => {
                if (!namespace) throw new Error("Namespace unavailable");
                return namespace.runtime.prepare(operation, resource, manifest, record);
              },
              catch: (error) =>
                new ProvisionProviderError({
                  ...(error instanceof ProvisionRetentionError ? { retentionFailed: true } : {}),
                  message: provisionFailureMessage(
                    error,
                    "Namespace preparation did not finish. Retry the same request.",
                  ),
                }),
            });
          const sandboxId = resource.sandboxId;
          return yield* Effect.tryPromise({
            try: () => runtime.prepare(operation, sandboxId, manifest, record),
            catch: (error) =>
              new ProvisionProviderError({
                ...(error instanceof ProvisionRetentionError ? { retentionFailed: true } : {}),
                message: provisionFailureMessage(
                  error,
                  "Remote preparation did not finish. Retry the same request to resume.",
                ),
              }),
          });
        }).pipe(
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
    const provisionControl = makeProvisionControl(
      store,
      provisioning,
      {
        freeze: async (input) => {
          const manager = await resolve();
          if (!manager)
            throw new ProvisionRefused({
              reason: "unconfigured",
              message: "This install has no cloud provisioning configuration.",
            });
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
            makeProvisionResolution({
              apiKey: manager.config.e2bApiKey,
              ...(manager.config.provisioning?.githubToken
                ? { githubToken: manager.config.provisioning.githubToken }
                : {}),
            }),
            // Credentials and the skill root follow the account's real settings
            // rather than a path this module guesses from the driver name.
            await resolveProfile(
              {
                provider: input.provider,
                providerInstanceId: input.providerInstanceId,
                ...(input.agentDriver ? { agentDriver: input.agentDriver } : {}),
              },
              manager.config.provisioning?.claudeOAuthTokens,
            ),
          );
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
          return makeE2bProvisionRuntime({ apiKey: manager.config.e2bApiKey }).attach(
            operation,
            resource.sandboxId,
            manifest,
            record,
          );
        },
        touch: async (operation) => {
          const manager = await resolve();
          if (!manager || operation.state.kind !== "ready") throw new Error("No ready runtime");
          const resource = operation.state.allocation.resource;
          if (resource.provider === "namespace")
            return (await resolveNamespace()).runtime.touch(operation, resource);
          return makeE2bProvisionRuntime({ apiKey: manager.config.e2bApiKey }).touch(
            operation,
            resource.sandboxId,
          );
        },
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
      yield* Effect.gen(function* () {
        // A lease is only registered once its provision reached ready, so an
        // expired heartbeat means a finished machine nobody is watching. Pause
        // it and leave it reconnectable. A provision that never reached ready
        // holds no lease and is disposed by its retention deadline instead.
        yield* Effect.promise(() => service.reapExpiredLeases()).pipe(Effect.ignore);
      }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(LEASE_REAP_INTERVAL_MS))));
    }).pipe(Effect.forkScoped);
    return {
      list: run((service) => service.list(), []),
      listProvisioned: listProvisionedEnvironments(sql),
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
      claim: (input) =>
        run<EnvironmentProvisionClaimResult>((service) => service.claim(input), {
          kind: "refused" as const,
          reason: "unknown" as const,
          message: "This install has no cloud provisioning template configured.",
        }),
      resume: (input) =>
        run<EnvironmentProvisionResumeResult>((service) => service.resume(input), {
          kind: "refused",
          reason: "unknown",
          message: "This install has no provisioning template configured.",
        }),
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
).pipe(Layer.provide(ProvisionOperationStore.layer));
