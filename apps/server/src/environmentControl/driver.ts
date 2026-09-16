// @effect-diagnostics globalFetch:off - this injected Promise driver owns SDK and controller HTTP I/O.
// @effect-diagnostics nodeBuiltinImport:off - provisioning reads account credentials at the same Promise boundary.
// @effect-diagnostics globalDate:off - the readiness deadline is wall-clock polling around that boundary.
// @effect-diagnostics cryptoRandomUUID:off - the environment ID is written into a sandbox, not Effect state.
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import { ALL_TRAFFIC, Sandbox, SandboxNotFoundError } from "e2b";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { loadUserToken, fromBearerToken } from "@namespacelabs/sdk/auth";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import * as Schema from "effect/Schema";
import {
  canonicalRepository,
  type EnvironmentControlConfig,
  type ManagedTarget,
} from "./config.ts";
import type { NamespaceResource } from "./namespaceProvisioner.ts";
import { disposeNamespace, namespaceT3Port, provisionNamespace } from "./namespaceProvisioner.ts";
import { createNamespaceSdkRunner } from "./namespaceSdkRunner.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";
import {
  resolvePreparation,
  ProvisionRefused,
  type ProvisioningProviderProfile,
} from "./ProvisioningProviderProfile.ts";

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
/** The port a provisioned environment serves T3 on. */
const PROVISIONED_PORT = 3001;
const PROVISIONED_TIMEOUT_MS = 6 * 3_600_000;

export class ProvisionedSandboxMissing extends Error {
  constructor() {
    super("E2B no longer has this workspace. It cannot be reconnected.");
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

export interface ProvisionRequest {
  readonly provider: "e2b" | "namespace";
  readonly providerInstanceId: string;
  /** Agent driver selected in the local composer. */
  readonly agentDriver?: string | undefined;
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
}
export interface Provisioned {
  readonly provider: "e2b" | "namespace";
  readonly sandboxId: string;
  readonly pairingUrl: string;
  readonly projectDir: string;
  readonly namespaceResource?: NamespaceResource;
  readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** `owner/name`, or a github.com URL in any of its usual spellings. */
export function repositoryUrl(repository: string): string {
  return `https://github.com/${canonicalRepository(repository)}.git`;
}

export function repositoryDirectory(repository: string): string {
  return `/home/user/work/${repositoryUrl(repository)
    .split("/")
    .pop()!
    .replace(/\.git$/, "")}`;
}

export interface CloudDriver {
  observe(target: ManagedTarget): Promise<Observation>;
  observeBroker(): Promise<Observation>;
  bootstrapBroker(): Promise<void>;
  wake(target: ManagedTarget): Promise<void>;
  pause(input: {
    readonly sandboxId: string;
    readonly namespaceResource?: NamespaceResource;
  }): Promise<void>;
  resume(input: {
    readonly leaseId: string;
    readonly sandboxId: string;
    readonly environmentId: string;
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
  provision(request: ProvisionRequest): Promise<Provisioned>;
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

/**
 * Everything a created sandbox needs before anyone can pair with it.
 *
 * Split out so the caller can destroy a sandbox whose preparation failed: a
 * half-built environment is unreachable, still billing, and its id is known to
 * nobody once the error propagates.
 */
async function prepare(
  sandbox: Sandbox,
  provisioning: NonNullable<EnvironmentControlConfig["provisioning"]>,
  request: ProvisionRequest,
  preparation: Awaited<ReturnType<typeof resolvePreparation>>,
): Promise<Provisioned> {
  const { profile } = preparation;
  const t3Home = "/home/user/.t3-cloud";
  const environment = [
    ...preparation.environment.filter(
      ({ name }) =>
        name !== "T3CODE_HOME" && name !== "NPM_CONFIG_PREFIX" && name !== "NODE_OPTIONS",
    ),
    { name: "T3CODE_HOME", value: t3Home, sensitive: false },
    { name: "NPM_CONFIG_PREFIX", value: "/home/user/.local", sensitive: false },
    { name: "NODE_OPTIONS", value: "--max-old-space-size=4096", sensitive: false },
  ];
  const envs = Object.fromEntries(environment.map(({ name, value }) => [name, value]));
  const run = async (command: string, timeoutMs = 180_000) => {
    try {
      const result = await sandbox.commands.run(command, { timeoutMs, envs });
      if (result.exitCode !== 0) throw new Error("Nonzero exit");
      return result;
    } catch {
      throw new Error("E2B preparation command failed.");
    }
  };
  const write = async (path: string, contents: string) => {
    await run(`mkdir -p ${shellQuote(NodePath.posix.dirname(path))}`);
    await sandbox.files.write(path, contents);
    await run(`chmod 600 ${shellQuote(path)}`);
  };
  for (const file of preparation.files)
    await write(
      NodePath.posix.join("/home/user", file.destination),
      await NodeFSP.readFile(file.source, "utf8"),
    );
  await write(
    "/home/user/.profile.d-agents.sh",
    environment.map(({ name, value }) => `export ${name}=${shellQuote(value)}`).join("\n") + "\n",
  );
  for (const path of ["/home/user/.bashrc", "/home/user/.profile"])
    await run(
      `grep -q profile.d-agents ${shellQuote(path)} 2>/dev/null || printf '%s\\n' '. /home/user/.profile.d-agents.sh' >> ${shellQuote(path)}`,
    );
  const providerConfig =
    profile.kind === "codex"
      ? { homePath: "/home/user/.codex" }
      : profile.kind === "claudeAgent"
        ? { homePath: "/home/user/.claude" }
        : { binaryPath: "/home/user/.local/bin/agent" };
  await write(
    `${t3Home}/userdata/settings.json`,
    JSON.stringify({
      providers: Object.fromEntries(
        Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((driver) => [
          driver,
          { enabled: false },
        ]),
      ),
      providerInstances: {
        [profile.instanceId]: {
          driver: profile.kind,
          enabled: true,
          config: providerConfig,
          environment,
        },
      },
    }),
  );
  if (provisioning.githubToken) {
    await write(
      "/home/user/.config/gh/hosts.yml",
      `github.com:\n    oauth_token: ${provisioning.githubToken}\n    git_protocol: https\n`,
    );
    await write(
      "/home/user/.git-credentials",
      `https://x-access-token:${provisioning.githubToken}@github.com\n`,
    );
    await run(
      "git config --global credential.helper store && git config --global user.email agent@t3.local && git config --global user.name t3",
    );
  }
  const projectDir = request.repository
    ? repositoryDirectory(request.repository)
    : "/home/user/work";
  if (request.repository) {
    const branch = request.branch ? `--branch ${shellQuote(request.branch)} ` : "";
    await run(
      `mkdir -p /home/user/work && git clone --filter=blob:none ${branch}-- ${shellQuote(repositoryUrl(request.repository))} ${shellQuote(projectDir)}`,
      900_000,
    );
  } else {
    await run(
      "mkdir -p /home/user/work && cd /home/user/work && (git rev-parse --git-dir >/dev/null 2>&1 || (git init -q && git config user.email agent@t3.local && git config user.name t3 && echo '# workspace' > README.md && git add -A && git commit -qm init))",
    );
  }
  for (const file of preparation.workspaceFiles)
    await write(
      NodePath.posix.join(projectDir, file.destination),
      await NodeFSP.readFile(file.source, "utf8"),
    );

  const providerInstall = {
    codex:
      'npm install --global --no-fund --no-audit @openai/codex@latest && "$HOME/.local/bin/codex" --version',
    claudeAgent:
      'npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest && "$HOME/.local/bin/claude" --version',
    cursor:
      `curl https://cursor.com/install -fsS -o ${shellQuote(`${t3Home}/cursor-install.sh`)} && ` +
      `bash ${shellQuote(`${t3Home}/cursor-install.sh`)} && ` +
      '"$HOME/.local/bin/agent" --version && ' +
      'if [ ! -e "$HOME/.local/bin/cursor-agent" ]; then ln -s agent "$HOME/.local/bin/cursor-agent"; fi',
  }[profile.kind];
  const logs = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e2b-preparation-"));
  for (const [phase, commands] of [
    ["provider-install", [providerInstall]],
    ["prepare", preparation.prepareCommands],
    ["verify", preparation.verifyCommands],
  ] as const) {
    for (const [index, command] of commands.entries()) {
      const script = `${t3Home}/${phase}-${index}.sh`;
      const log = `${t3Home}/${phase}-${index}.log`;
      await write(
        script,
        `#!/bin/sh\nset -eu\n. /home/user/.profile.d-agents.sh\ncd ${shellQuote(projectDir)}\n${command}\n`,
      );
      let failed = false;
      try {
        await run(`umask 077; sh ${shellQuote(script)} > ${shellQuote(log)} 2>&1`, 900_000);
      } catch {
        failed = true;
      }
      const output = await sandbox.files.read(log).catch(() => "Command log unavailable.\n");
      const localLog = NodePath.join(logs, `${phase}-${index}.log`);
      await NodeFSP.writeFile(localLog, output, { mode: 0o600 });
      if (failed) throw new Error(`E2B ${phase} failed. Private log: ${localLog}`);
    }
  }
  const label = request.repository
    ? `${canonicalRepository(request.repository).split("/")[1]} · ${profile.instanceId}`
    : profile.instanceId;
  await run(
    `printf 'PRETTY_HOSTNAME=%s\\n' ${shellQuote(JSON.stringify(label))} | sudo tee /etc/machine-info >/dev/null`,
  ).catch(() => undefined);
  const environmentId = globalThis.crypto.randomUUID();
  await write(`${t3Home}/userdata/environment-id`, `${environmentId}\n`);
  await write(
    `${t3Home}/serve.sh`,
    `#!/bin/sh\nset -eu\n. /home/user/.profile.d-agents.sh\ncd ${shellQuote(projectDir)}\nexec t3 serve --no-browser --host 0.0.0.0 --port ${PROVISIONED_PORT}\n`,
  );
  await run(
    `umask 077; nohup sh ${shellQuote(`${t3Home}/serve.sh`)} > ${shellQuote(`${t3Home}/serve.log`)} 2>&1 < /dev/null &`,
    20_000,
  );
  const host = sandbox.getHost(PROVISIONED_PORT);
  const deadline = Date.now() + 600_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await fetch(`https://${host}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const descriptor: unknown = await response.json();
        return (
          typeof descriptor === "object" &&
          descriptor !== null &&
          "environmentId" in descriptor &&
          descriptor.environmentId === environmentId
        );
      })
      .catch(() => false);
    if (!ready) await NodeTimersPromises.setTimeout(1_000);
  }
  if (!ready) {
    const log = NodePath.join(logs, "serve.log");
    await NodeFSP.writeFile(
      log,
      await sandbox.files.read(`${t3Home}/serve.log`).catch(() => "Server log unavailable.\n"),
      { mode: 0o600 },
    );
    throw new Error(
      `Provisioned environment never answered with its identity. Private log: ${log}`,
    );
  }
  await run(`t3 project add ${shellQuote(projectDir)}`);
  const paired = await run(
    `t3 pair --ttl 12h --label ${shellQuote(`cloud-${request.providerInstanceId}`)}`,
  );
  const token = /Token:\s*([A-Z0-9]+)/.exec(
    (paired.stdout ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""),
  )?.[1];
  if (!token) throw new Error("Could not mint a pairing token");
  return {
    provider: "e2b",
    sandboxId: sandbox.sandboxId,
    pairingUrl: `https://${host}/pair#token=${token}`,
    projectDir,
  };
}

export function createCloudDriver(
  config: EnvironmentControlConfig,
  resolveProfile?: (request: ProvisionRequest) => Promise<ProvisioningProviderProfile>,
): CloudDriver {
  const api = { apiKey: config.e2bApiKey, requestTimeoutMs: 15_000 };
  const namespaceRunner = config.provisioning?.namespace
    ? createNamespaceSdkRunner(
        config.namespaceToken === undefined ? {} : { token: config.namespaceToken },
      )
    : undefined;
  const namespaceProxy = new NamespaceProxyManager();
  const namespaceTokenSource = config.namespaceToken
    ? fromBearerToken(config.namespaceToken)
    : {
        issueToken: async (minDuration: number, force?: boolean) =>
          (await loadUserToken()).issueToken(minDuration, force),
      };
  const getNamespaceAuthorization = async () =>
    `Bearer ${await namespaceTokenSource.issueToken(60_000)}`;
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
      const tokenSource = namespaceTokenSource;
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
    provision: async (request) => {
      const provisioning = config.provisioning;
      if (!provisioning)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: "This install has no cloud provisioning template configured.",
        });
      if (request.repository && !provisioning.githubToken)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: "Cloning a repository needs a configured GitHub token.",
        });
      if (!resolveProfile)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: "Provider account resolution is unavailable.",
        });
      const profile = await resolveProfile(request);
      const preparation = await resolvePreparation(
        profile,
        provisioning,
        request.provider,
        request.repository,
      );

      if (request.provider === "namespace") {
        if (!config.provisioning?.namespace)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "Namespace provisioning is not configured on this install.",
          });
        if (!namespaceRunner)
          throw new ProvisionRefused({
            reason: "unsupported",
            message: "Namespace provisioning is unavailable.",
          });
        await getNamespaceAuthorization();
        const prepared = await provisionNamespace(namespaceRunner, {
          ...config.provisioning.namespace,
          providerInstanceId: request.providerInstanceId,
          agentDriver: profile.kind,
          repository: request.repository,
          branch: request.branch,
          githubToken: config.provisioning.githubToken,
          ...preparation,
        });
        try {
          const upstream = new URL(prepared.pairingUrl);
          const proxy = await namespaceProxy.open({
            proxyId: NodeCrypto.randomUUID(),
            upstreamHttpBaseUrl: `${upstream.origin}/`,
            upstreamWsBaseUrl: `${upstream.protocol === "https:" ? "wss:" : "ws:"}//${upstream.host}/`,
            getUpstreamAuthorization: getNamespaceAuthorization,
          });
          const pairing = new URL(prepared.pairingUrl);
          pairing.protocol = "http:";
          pairing.host = new URL(proxy.proxyOrigin).host;
          return {
            provider: "namespace",
            sandboxId: prepared.resource.devboxId,
            pairingUrl: pairing.toString(),
            projectDir: prepared.projectDir,
            namespaceResource: prepared.resource,
            namespaceProxy: proxy,
          };
        } catch (cause) {
          await disposeNamespace(namespaceRunner, prepared.resource).catch(() => undefined);
          throw cause;
        }
      }
      if (!provisioning.templateId)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: "E2B provisioning is not configured on this install.",
        });
      const allowed = provisioning.egressAllow;
      const network =
        allowed && allowed.length > 0
          ? { network: { allowOut: [...allowed], denyOut: [ALL_TRAFFIC] } }
          : {};
      // Forks inherit this policy. Keep their memory and files at the deadline;
      // the temporary parent is explicitly killed after forking.
      const parent = await Sandbox.create(provisioning.templateId, {
        ...api,
        timeoutMs: 10 * 60_000,
        lifecycle: { onTimeout: "pause", autoResume: false },
        metadata: { purpose: "t3-environment", account: request.providerInstanceId },
        // Denying everything first is what makes the allow list meaningful;
        // without the deny, listing hosts grants nothing and blocks nothing.
        ...network,
      });
      let sandbox: Sandbox | undefined;
      try {
        const fork = (await parent.fork({ count: 1, timeoutMs: PROVISIONED_TIMEOUT_MS }))[0];
        if (!(fork instanceof Sandbox))
          throw new Error(`Could not fork the E2B template: ${String(fork)}`);
        sandbox = fork;
        await parent.kill();
        return await prepare(sandbox, provisioning, request, preparation);
      } catch (cause) {
        // A sandbox that never finished being prepared is unreachable and
        // still billing, and nothing else knows its id to clean up later.
        await sandbox?.kill().catch(() => undefined);
        await parent.kill().catch(() => undefined);
        throw cause;
      }
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
        await namespaceRunner.destroyInstance(namespaceResource);
        return;
      }
      try {
        const sandbox = await Sandbox.connect(sandboxId, { ...api, timeoutMs: 90_000 });
        await sandbox.pause();
      } catch (cause) {
        if (isMissingSandbox(cause)) return;
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
