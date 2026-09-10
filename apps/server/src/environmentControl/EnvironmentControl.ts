// @effect-diagnostics globalDate:off - provider driver snapshots use the same ISO wire format from a Promise boundary.
import {
  EnvironmentControlError,
  type ComputeState,
  type EnvironmentId,
  type EnvironmentControlResult,
  type ManagedEnvironment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readConfig, type ManagedTarget } from "./config.ts";
import { createCloudDriver, type CloudDriver } from "./driver.ts";

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
  return {
    list: () => Promise.all(targets.map(snapshot)),
    start: (id: EnvironmentId) => command(id, "start"),
    stop: (id: EnvironmentId) => command(id, "stop"),
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
  }
>()("t3/environmentControl/EnvironmentControl") {}

export const layer = Layer.sync(EnvironmentControl, () => {
  let manager: Promise<ReturnType<typeof createEnvironmentControl> | null> | undefined;
  const resolve = () =>
    (manager ??= (async () => {
      const path = process.env.T3CODE_ENVIRONMENT_CONTROL_CONFIG;
      if (!path) return null;
      const config = await readConfig(path);
      return createEnvironmentControl(config.targets, createCloudDriver(config));
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
    start: (id) => run((service) => service.start(id), refused("unknown")),
    stop: (id) => run((service) => service.stop(id), refused("unknown")),
  };
});
