// @effect-diagnostics globalFetch:off - this injected Promise driver owns SDK and controller HTTP I/O.
import * as NodeTimersPromises from "node:timers/promises";
import { Sandbox } from "e2b";
import { loadUserToken, fromBearerToken } from "@namespacelabs/sdk/auth";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import * as Schema from "effect/Schema";
import type { EnvironmentControlConfig, ManagedTarget } from "./config.ts";

export type Observation =
  | { readonly kind: "stopped" }
  | { readonly kind: "running"; readonly instanceId: string };
export const ControllerResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stopped") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["busy", "unknown", "stale", "unprepared", "unsupported", "conflict"]),
  }),
]);
export type ControllerResult = typeof ControllerResult.Type;
export interface CloudDriver {
  observe(target: ManagedTarget): Promise<Observation>;
  observeBroker(): Promise<Observation>;
  bootstrapBroker(): Promise<void>;
  wake(target: ManagedTarget): Promise<void>;
  stop(target: ManagedTarget, instanceId: string): Promise<ControllerResult>;
}
const Capabilities = Schema.Struct({
  protocol: Schema.Literal(2),
  manualStop: Schema.Literal(true),
});

const decodeCapabilities = Schema.decodeUnknownExit(Capabilities);
const decodeControllerResult = Schema.decodeUnknownSync(ControllerResult);

export function createCloudDriver(config: EnvironmentControlConfig): CloudDriver {
  const api = { apiKey: config.e2bApiKey, requestTimeoutMs: 15_000 };
  async function e2bInfo(
    identity:
      | EnvironmentControlConfig["broker"]
      | Extract<ManagedTarget["machine"], { provider: "e2b" }>,
  ) {
    const info = await Sandbox.getInfo(identity.sandboxId, api);
    if (
      info.sandboxId !== identity.sandboxId ||
      info.lifecycle?.onTimeout !== "pause" ||
      !Object.entries(identity.metadata).every(([key, value]) => info.metadata[key] === value)
    )
      throw new Error("Sandbox ownership or persistence changed");
    if (info.state !== "paused" && info.state !== "running")
      throw new Error("Unknown sandbox state");
    return info;
  }
  async function observeE2b(identity: Parameters<typeof e2bInfo>[0]): Promise<Observation> {
    const info = await e2bInfo(identity);
    return info.state === "paused"
      ? { kind: "stopped" }
      : { kind: "running", instanceId: info.sandboxId };
  }
  async function controller(target: ManagedTarget, action: string, body?: unknown) {
    if ((await observeE2b(config.broker)).kind !== "running")
      throw new Error("Controller is paused");
    const response = await fetch(new URL(`/hosts/${target.hostId}/${action}`, config.broker.url), {
      redirect: "error",
      method: action === "capabilities" ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${target.operatorToken}`,
        "e2b-traffic-access-token": config.broker.ingressKey,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(
        action === "stop" ? 90_000 : action === "capabilities" ? 3_000 : 180_000,
      ),
    });
    return response;
  }
  async function waitForControllerReady(target: ManagedTarget) {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response = await controller(target, "capabilities");
        const controllerResponded =
          response.ok || response.status === 401 || response.status === 404;
        if (controllerResponded) return;
      } catch {}
      await NodeTimersPromises.setTimeout(1_000);
    }
    throw new Error("Controller is not ready");
  }
  return {
    observe: async (target) => {
      const machine = target.machine;
      if (machine.provider === "e2b") return observeE2b(machine);
      const tokenSource = config.namespaceToken
        ? fromBearerToken(config.namespaceToken)
        : await loadUserToken();
      const devbox = createClient(
        DevBoxService,
        createGlobalTransport({
          tokenSource,
          baseUrl: "https://private-api.global.namespaceapis.com",
        }),
      );
      const result = await devbox.fetch(
        { name: machine.name, returnActivatedInstance: true },
        { timeoutMs: 15_000 },
      );
      if (result.devbox?.id !== machine.devboxId || result.devbox.volumeName !== machine.volumeName)
        throw new Error("Devbox ownership changed");
      if (!result.instanceId) return { kind: "stopped" };
      const compute = createClient(
        ComputeService,
        createRegionTransport(machine.region, { tokenSource }),
      );
      const instance = await compute.describeInstance(
        { instanceId: result.instanceId },
        { timeoutMs: 15_000 },
      );
      if (!instance.metadata || instance.metadata.destroyedAt)
        throw new Error("Unknown devbox instance");
      return { kind: "running", instanceId: result.instanceId };
    },
    observeBroker: () => observeE2b(config.broker),
    bootstrapBroker: async () => {
      await e2bInfo(config.broker);
      await Sandbox.connect(config.broker.sandboxId, { ...api, timeoutMs: 3_600_000 });
      if ((await observeE2b(config.broker)).kind !== "running")
        throw new Error("Controller did not resume");
    },
    wake: async (target) => {
      await waitForControllerReady(target);
      const response = await controller(target, "wake");
      if (!response.ok) throw new Error("Controller wake failed");
    },
    stop: async (target, instanceId) => {
      const response = await controller(target, "capabilities");
      if (!response.ok) return { kind: "refused", reason: "unsupported" };
      const capability = decodeCapabilities(await response.json());
      if (capability._tag === "Failure") return { kind: "refused", reason: "unsupported" };
      const stopped = await controller(target, "stop", { instanceId });
      if (!stopped.ok) throw new Error("Controller refused stop request");
      return decodeControllerResult(await stopped.json());
    },
  };
}
