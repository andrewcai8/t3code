// @effect-diagnostics globalDate:off - provider control crosses a Promise boundary.
// @effect-diagnostics nodeBuiltinImport:off - provider control resolves state in a Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  EnvironmentControlError,
  type ComputeState,
  type EnvironmentId,
  type EnvironmentControlResult,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
  type EnvironmentProvisionDisposeInput,
  type EnvironmentProvisionDisposeResult,
  type EnvironmentProvisionClaimInput,
  type EnvironmentProvisionClaimResult,
  type EnvironmentProvisionTouchInput,
  type EnvironmentProvisionTouchResult,
  type ManagedEnvironment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import { readConfig, resolveControlConfigPath, type ManagedTarget } from "./config.ts";
import {
  createCloudDriver,
  ProvisionRefused,
  type CloudDriver,
  type ProvisionRequest,
} from "./driver.ts";
import {
  createProvisionedLeaseRegistry,
  type ProvisionedLeaseRegistry,
} from "./ProvisionedLeaseRegistry.ts";

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
) {
  const pending = new Map<
    EnvironmentId,
    { action: "start" | "stop"; promise: Promise<EnvironmentControlResult> }
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
  const reapExpiredLeases = async (): Promise<void> => {
    if (!leaseRegistry) return;
    for (const lease of await leaseRegistry.expired()) {
      const release =
        lease.state === "releasing"
          ? "started"
          : await leaseRegistry.beginRelease({
              leaseId: lease.leaseId,
              sandboxId: lease.sandboxId,
            });
      if (release !== "started") continue;
      try {
        await driver.dispose(lease.sandboxId);
        await leaseRegistry.markDisposed(lease.leaseId);
      } catch {
        // Leave the lease releasing so the next control request can retry it.
      }
    }
  };
  return {
    list: () => Promise.all(targets.map(snapshot)),
    start: (id: EnvironmentId) => command(id, "start"),
    stop: (id: EnvironmentId) => command(id, "stop"),
    // Provisioning does not touch the declared targets, so it needs none of
    // the fencing above: there is no existing environment to race with. A
    // declined request is an answer the caller can act on, so it is mapped
    // here rather than collapsing into "the provider is unavailable".
    provision: async (request: ProvisionRequest): Promise<EnvironmentProvisionResult> => {
      try {
        const environment = await driver.provision(request);
        const leaseId = NodeCrypto.randomUUID();
        if (leaseRegistry) {
          try {
            await leaseRegistry.register({
              leaseId,
              sandboxId: environment.sandboxId,
              providerInstanceId: request.providerInstanceId,
            });
          } catch (cause) {
            await driver.dispose(environment.sandboxId).catch(() => undefined);
            throw cause;
          }
        }
        return {
          kind: "provisioned",
          environment: { ...environment, leaseId, providerInstanceId: request.providerInstanceId },
        };
      } catch (cause) {
        if (cause instanceof ProvisionRefused)
          return { kind: "refused", reason: cause.reason, message: cause.message };
        throw cause;
      }
    },
    dispose: async (
      input: EnvironmentProvisionDisposeInput,
    ): Promise<EnvironmentProvisionDisposeResult> => {
      try {
        if (leaseRegistry) {
          const release = await leaseRegistry.beginRelease(input);
          if (release === "disposed") return { kind: "disposed" };
          if (release === "busy")
            return {
              kind: "refused",
              reason: "unknown",
              message: "Another cleanup is already in progress.",
            };
          if (release === "started") {
            try {
              await driver.dispose(input.sandboxId);
              const lease = await leaseRegistry.findBySandbox(input.sandboxId);
              if (lease) await leaseRegistry.markDisposed(lease.leaseId);
              return { kind: "disposed" };
            } catch {
              return {
                kind: "refused",
                reason: "unknown",
                message: "The cloud sandbox could not be disposed.",
              };
            }
          }
        }
        await driver.dispose(input.sandboxId);
        return { kind: "disposed" };
      } catch {
        return {
          kind: "refused",
          reason: "unknown",
          message: "The cloud sandbox could not be disposed.",
        };
      }
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
      return (await leaseRegistry.touch(input.leaseId))
        ? { kind: "touched" }
        : {
            kind: "refused",
            reason: "unknown",
            message: "The cloud sandbox lease could not be renewed.",
          };
    },
    reapExpiredLeases,
  };
}

export class EnvironmentControl extends Context.Service<
  EnvironmentControl,
  {
    readonly list: Effect.Effect<ReadonlyArray<ManagedEnvironment>, EnvironmentControlError>;
    readonly start: (
      id: EnvironmentId,
    ) => Effect.Effect<EnvironmentControlResult, EnvironmentControlError>;
    readonly stop: (
      id: EnvironmentId,
    ) => Effect.Effect<EnvironmentControlResult, EnvironmentControlError>;
    readonly provision: (
      input: EnvironmentProvisionInput,
    ) => Effect.Effect<EnvironmentProvisionResult, EnvironmentControlError>;
    readonly dispose: (
      input: EnvironmentProvisionDisposeInput,
    ) => Effect.Effect<EnvironmentProvisionDisposeResult, EnvironmentControlError>;
    readonly claim: (
      input: EnvironmentProvisionClaimInput,
    ) => Effect.Effect<EnvironmentProvisionClaimResult, EnvironmentControlError>;
    readonly touch: (
      input: EnvironmentProvisionTouchInput,
    ) => Effect.Effect<EnvironmentProvisionTouchResult, EnvironmentControlError>;
  }
>()("t3/environmentControl/EnvironmentControl") {}

export const layer = Layer.effect(
  EnvironmentControl,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    let manager: Promise<ReturnType<typeof createEnvironmentControl> | null> | undefined;
    const resolve = () =>
      (manager ??= (async () => {
        const path = await resolveControlConfigPath({
          explicit: process.env.T3CODE_ENVIRONMENT_CONTROL_CONFIG,
          stateDir,
          fallback: NodePath.join(NodeOS.homedir(), ".t3", "environment-control.json"),
        });
        if (!path) return null;
        const config = await readConfig(path);
        const leaseRegistry = createProvisionedLeaseRegistry(
          NodePath.join(stateDir, "provisioned-sandbox-leases.json"),
        );
        const service = createEnvironmentControl(
          config.targets,
          createCloudDriver(config),
          leaseRegistry,
        );
        await service.reapExpiredLeases();
        return service;
      })());
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
    return {
      list: run((service) => service.list(), []),
      provision: (input) =>
        run<EnvironmentProvisionResult>(
          (service) =>
            service.provision({
              providerInstanceId: input.providerInstanceId,
              repository: input.repository,
              branch: input.branch,
            }),
          // An install with no provisioning template is the ordinary case for a
          // machine that only manages named targets, not a failure.
          {
            kind: "refused" as const,
            reason: "unconfigured" as const,
            message: "This install has no cloud provisioning template configured.",
          },
        ),
      dispose: (input) =>
        run<EnvironmentProvisionDisposeResult>((service) => service.dispose(input), {
          kind: "refused" as const,
          reason: "unconfigured" as const,
          message: "This install has no cloud provisioning template configured.",
        }),
      claim: (input) =>
        run<EnvironmentProvisionClaimResult>((service) => service.claim(input), {
          kind: "refused" as const,
          reason: "unknown" as const,
          message: "This install has no cloud provisioning template configured.",
        }),
      touch: (input) =>
        run<EnvironmentProvisionTouchResult>((service) => service.touch(input), {
          kind: "refused" as const,
          reason: "unknown" as const,
          message: "This install has no cloud provisioning template configured.",
        }),
      start: (id) => run((service) => service.start(id), refused("unknown")),
      stop: (id) => run((service) => service.stop(id), refused("unknown")),
    };
  }),
);
