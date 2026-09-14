// @effect-diagnostics globalFetch:off - this injected Promise driver owns SDK and controller HTTP I/O.
// @effect-diagnostics nodeBuiltinImport:off - provisioning reads account credentials at the same Promise boundary.
// @effect-diagnostics globalDate:off - the readiness deadline is wall-clock polling around that boundary.
import * as NodeTimersPromises from "node:timers/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { Sandbox } from "e2b";
import { loadUserToken, fromBearerToken } from "@namespacelabs/sdk/auth";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import * as Schema from "effect/Schema";
import type { EnvironmentControlConfig, ManagedTarget } from "./config.ts";
import type { NamespaceResource } from "./namespaceProvisioner.ts";
import { disposeNamespace } from "./namespaceProvisioner.ts";
import { createNamespaceSdkRunner } from "./namespaceSdkRunner.ts";
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
function isMissingSandbox(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:status\s*[:=]?\s*)?404\b|sandbox[^\n]*not found/i.test(message);
}

/**
 * A provisioning request the driver declines rather than fails.
 *
 * An install with no template, or an account with no credentials on this
 * machine, is an ordinary configuration state and deserves a specific answer
 * the caller can act on — not the generic "provider is unavailable" a thrown
 * error would produce.
 */
export class ProvisionRefused extends Error {
  readonly reason: "unconfigured" | "credentials" | "unsupported";
  constructor(reason: "unconfigured" | "credentials" | "unsupported", message: string) {
    super(message);
    this.reason = reason;
    this.name = "ProvisionRefused";
  }
}

/**
 * Where a provider account keeps its credentials.
 *
 * Each Codex instance gets a shadow home, and every entry in it except
 * `auth.json` links back to the shared one, so that file alone is what
 * distinguishes one account from another.
 */
export function accountAuthPath(providerInstanceId: string, home = NodeOS.homedir()): string {
  if (providerInstanceId === "cursor" || providerInstanceId.startsWith("cursor_")) {
    return NodePath.join(
      home,
      ".t3/userdata/cursor-homes",
      providerInstanceId,
      ".cursor/auth.json",
    );
  }
  return providerInstanceId === "codex"
    ? NodePath.join(home, ".codex/auth.json")
    : NodePath.join(home, `.${providerInstanceId}/auth.json`);
}

type ChildSettings = {
  providers?: Record<string, Record<string, unknown>>;
  providerInstances?: Record<string, ChildProviderInstanceSettings>;
  [key: string]: unknown;
};
type ChildProviderInstanceSettings = Record<string, unknown> & {
  environment?: Array<{ name: string; value: string; sensitive?: boolean }>;
};

export function enableChildProvider(
  existing: string,
  agentDriver: string,
  providerInstanceId: string,
  homePath = "/home/user",
): string {
  let settings: ChildSettings = {};
  try {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as ChildSettings;
    }
  } catch {}
  const providers = settings.providers ?? {};
  const providerInstances = settings.providerInstances ?? {};
  const existingInstance = providerInstances[providerInstanceId] ?? {};
  const environment =
    agentDriver === "cursor"
      ? [
          ...(existingInstance.environment ?? []).filter(
            (variable) =>
              !["AGENT_CLI_CREDENTIAL_STORE", "CURSOR_CONFIG_DIR", "HOME"].includes(variable.name),
          ),
          { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
          { name: "CURSOR_CONFIG_DIR", value: `${homePath}/.config/cursor`, sensitive: false },
          { name: "HOME", value: homePath, sensitive: false },
        ]
      : existingInstance.environment;
  return `${JSON.stringify({
    ...settings,
    providers: {
      ...providers,
      [agentDriver]: { ...providers[agentDriver], enabled: true },
    },
    providerInstances: {
      ...providerInstances,
      [providerInstanceId]: {
        ...existingInstance,
        driver: agentDriver,
        enabled: true,
        ...(agentDriver === "codex" ? { homePath: `${homePath}/.codex`, shadowHomePath: "" } : {}),
        ...(environment ? { environment } : {}),
      },
    },
  })}\n`;
}

/** `owner/name`, or a github.com URL in any of its usual spellings. */
export function repositoryUrl(repository: string): string {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
    repository,
  );
  if (!match) throw new Error("Repository must look like owner/name");
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

export interface CloudDriver {
  observe(target: ManagedTarget): Promise<Observation>;
  observeBroker(): Promise<Observation>;
  bootstrapBroker(): Promise<void>;
  wake(target: ManagedTarget): Promise<void>;
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
    /**
     * Create an environment and leave it serving, paired only by the one-time
     * token returned here. The sandbox pauses when idle rather than being
     * killed, so an environment costs nothing between uses and resumes with its
     * processes intact.
     */
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
