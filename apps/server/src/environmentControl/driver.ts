// @effect-diagnostics globalFetch:off - this injected Promise driver owns SDK and controller HTTP I/O.
// @effect-diagnostics nodeBuiltinImport:off - this Promise driver polls and compares SDK state outside Effect.
// @effect-diagnostics globalDate:off - the readiness deadline is wall-clock polling around that boundary.
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { ALL_TRAFFIC, Sandbox, SandboxNotFoundError } from "e2b";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import * as Schema from "effect/Schema";
import {
  canonicalRepository,
  type EnvironmentControlConfig,
  type ManagedTarget,
} from "./config.ts";
import {
  disposeNamespace,
  namespaceT3Port,
  type NamespaceResource,
} from "./namespaceProvisioner.ts";
import { createNamespaceSdkRunner } from "./namespaceSdkRunner.ts";
import { namespaceTokenSource } from "./namespaceAllocation.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";

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
const PROVISIONED_TIMEOUT_MS = 6 * 3_600_000;

export class ProvisionedSandboxMissing extends Error {
  constructor() {
    super("The cloud provider no longer has this workspace. It cannot be reconnected.");
  }
}

function isMissingSandbox(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:status\s*[:=]?\s*)?404\b|sandbox[^\n]*not found/i.test(message);
}

function sameNetworkAddresses(actual: readonly string[] | undefined, desired: readonly string[]) {
  const current = new Set(actual?.map((address) => address.toLowerCase()));
  const expected = new Set(desired.map((address) => address.toLowerCase()));
  return current.size === expected.size && [...expected].every((address) => current.has(address));
}

/** `owner/name`, or a github.com URL in any of its usual spellings. */
export function repositoryUrl(repository: string): string {
  return `https://github.com/${canonicalRepository(repository)}.git`;
}

export interface CloudDriver {
  observe(target: ManagedTarget): Promise<Observation>;
  observeBroker(): Promise<Observation>;
  bootstrapBroker(): Promise<void>;
  wake(target: ManagedTarget): Promise<void>;
  pause(input: {
    readonly sandboxId: string;
    readonly namespaceResource?: NamespaceResource;
  }): Promise<void | "missing">;
  resume(input: {
    readonly leaseId: string;
    readonly sandboxId: string;
    readonly environmentId?: string;
    readonly providerInstanceId: string;
    readonly namespaceResource?: NamespaceResource;
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
  }): Promise<{
    readonly namespaceResource?: NamespaceResource;
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
  }>;
  renew(input: {
    readonly sandboxId: string;
    readonly providerInstanceId: string;
  }): Promise<"running" | "paused" | "missing">;
  stop(target: ManagedTarget, instanceId: string): Promise<ControllerResult>;
  dispose(input: {
    readonly sandboxId: string;
    readonly namespaceResource?: NamespaceResource;
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
  }): Promise<void>;
}
const Capabilities = Schema.Struct({
  protocol: Schema.Literal(2),
  manualStop: Schema.Literal(true),
});

const decodeCapabilities = Schema.decodeUnknownExit(Capabilities);
const decodeControllerResult = Schema.decodeUnknownSync(ControllerResult);

export function createCloudDriver(config: EnvironmentControlConfig): CloudDriver {
  const api = { apiKey: config.e2bApiKey, requestTimeoutMs: 15_000 };
  const namespaceRunner = config.provisioning?.namespace
    ? createNamespaceSdkRunner(
        config.namespaceToken === undefined ? {} : { token: config.namespaceToken },
      )
    : undefined;
  const namespaceProxy = new NamespaceProxyManager();
  const namespaceTokens = namespaceTokenSource(config.namespaceToken);
  const getNamespaceAuthorization = async () =>
    `Bearer ${await namespaceTokens.issueToken(60_000)}`;
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
  async function provisionedE2bInfo(sandboxId: string, providerInstanceId: string) {
    const info = await Sandbox.getInfo(sandboxId, api);
    if (
      info.sandboxId !== sandboxId ||
      info.metadata.purpose !== "t3-environment" ||
      info.metadata.account !== providerInstanceId
    )
      throw new Error("Sandbox ownership or purpose changed");
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
      const tokenSource = namespaceTokens;
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
    dispose: async ({ sandboxId, namespaceResource, namespaceProxy: proxy }) => {
      if (namespaceResource) {
        if (!namespaceRunner) throw new Error("Namespace runner is unavailable");
        if (proxy) await namespaceProxy.close(proxy);
        await disposeNamespace(namespaceRunner, namespaceResource);
        return;
      }
      let info: Awaited<ReturnType<typeof Sandbox.getInfo>>;
      try {
        info = await Sandbox.getInfo(sandboxId, api);
      } catch (cause) {
        // Disposal is safe to retry after a client crash or a provider-side
        // cleanup. A missing sandbox is already in the desired state.
        if (isMissingSandbox(cause)) return;
        throw cause;
      }
      if (info.sandboxId !== sandboxId || info.metadata.purpose !== "t3-environment") {
        throw new Error("Sandbox ownership or purpose changed");
      }
      try {
        const sandbox = await Sandbox.connect(sandboxId, { ...api, timeoutMs: 90_000 });
        await sandbox.kill();
      } catch (cause) {
        if (!isMissingSandbox(cause)) throw cause;
      }
    },
    resume: async ({
      sandboxId,
      environmentId,
      providerInstanceId,
      namespaceResource,
      namespaceProxy: proxy,
    }) => {
      if (namespaceResource) {
        if (!namespaceRunner || !proxy)
          throw new Error("Namespace recovery configuration is unavailable");
        if (!environmentId) throw new Error("Namespace recovery needs an environment identity");
        const resumed = await namespaceRunner.resume({
          resource: namespaceResource,
          port: namespaceT3Port(namespaceResource),
          environmentId,
        });
        const upstream = new URL(resumed.upstreamOrigin);
        const restored = await namespaceProxy.restore({
          ...proxy,
          upstreamHttpBaseUrl: `${upstream.origin}/`,
          upstreamWsBaseUrl: `${upstream.protocol === "https:" ? "wss:" : "ws:"}//${upstream.host}/`,
          getUpstreamAuthorization: getNamespaceAuthorization,
        });
        return { namespaceResource: resumed.resource, namespaceProxy: restored };
      }
      try {
        await provisionedE2bInfo(sandboxId, providerInstanceId);
        await Sandbox.connect(sandboxId, { ...api, timeoutMs: PROVISIONED_TIMEOUT_MS });
        const resumed = await provisionedE2bInfo(sandboxId, providerInstanceId);
        if (resumed.state !== "running") throw new Error("Sandbox did not resume");
        const allowed = config.provisioning?.egressAllow;
        if (allowed !== undefined) {
          const allowOut = [...allowed];
          const denyOut = allowed.length > 0 ? [ALL_TRAFFIC] : [];
          const matchesPolicy = (info: typeof resumed) =>
            info.allowInternetAccess !== false &&
            sameNetworkAddresses(info.network?.allowOut, allowOut) &&
            sameNetworkAddresses(info.network?.denyOut, denyOut);
          if (!matchesPolicy(resumed)) {
            const network = resumed.network;
            // E2B omits proxy passwords from getInfo. Replacing that proxy
            // from its public fields would silently remove its credentials.
            if (network?.egressProxy?.username !== undefined)
              throw new Error("Cannot reconcile E2B network without the existing proxy password");
            await Sandbox.updateNetwork(
              sandboxId,
              {
                allowOut,
                denyOut,
                allowInternetAccess: true,
                ...(network?.rules ? { rules: network.rules } : {}),
                ...(network?.egressProxy ? { egressProxy: network.egressProxy } : {}),
              },
              api,
            );
            const verified = await provisionedE2bInfo(sandboxId, providerInstanceId);
            if (
              verified.state !== "running" ||
              !matchesPolicy(verified) ||
              !NodeUtil.isDeepStrictEqual(verified.network?.rules ?? {}, network?.rules ?? {}) ||
              !NodeUtil.isDeepStrictEqual(verified.network?.egressProxy, network?.egressProxy)
            )
              throw new Error("E2B network reconciliation did not preserve the requested policy");
          }
        }
        return {};
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError) throw new ProvisionedSandboxMissing();
        throw cause;
      }
    },
    renew: async ({ sandboxId, providerInstanceId }) => {
      try {
        const info = await provisionedE2bInfo(sandboxId, providerInstanceId);
        if (info.state === "paused") return "paused";
        if (info.endAt.getTime() < Date.now() + PROVISIONED_TIMEOUT_MS)
          await Sandbox.setTimeout(sandboxId, PROVISIONED_TIMEOUT_MS, api);
        return "running";
      } catch (cause) {
        if (!(cause instanceof SandboxNotFoundError)) throw cause;
        // A timeout update can race a provider pause. Observe again without
        // connect(), which would resume a workspace stopped by the user.
        try {
          const info = await provisionedE2bInfo(sandboxId, providerInstanceId);
          if (info.state === "paused") return "paused";
        } catch (observedCause) {
          if (observedCause instanceof SandboxNotFoundError) return "missing";
          throw observedCause;
        }
        throw cause;
      }
    },
    pause: async ({ sandboxId, namespaceResource }) => {
      if (namespaceResource) {
        if (!namespaceRunner) throw new Error("Namespace runner is unavailable");
        // Shutdown stops the active instance but retains the Devbox record and
        // workspace, so reconnect can resume it without reprovisioning.
        return namespaceRunner.destroyInstance(namespaceResource);
      }
      try {
        const sandbox = await Sandbox.connect(sandboxId, { ...api, timeoutMs: 90_000 });
        await sandbox.pause();
      } catch (cause) {
        if (cause instanceof SandboxNotFoundError) return "missing";
        throw cause;
      }
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
