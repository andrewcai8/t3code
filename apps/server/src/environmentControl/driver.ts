// @effect-diagnostics globalFetch:off - this injected Promise driver owns SDK and controller HTTP I/O.
// @effect-diagnostics nodeBuiltinImport:off - provisioning reads account credentials at the same Promise boundary.
// @effect-diagnostics globalDate:off - the readiness deadline is wall-clock polling around that boundary.
// @effect-diagnostics cryptoRandomUUID:off - the environment ID is written into a sandbox, not Effect state.
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { ALL_TRAFFIC, Sandbox } from "e2b";
import { loadUserToken, fromBearerToken } from "@namespacelabs/sdk/auth";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import * as Schema from "effect/Schema";
import type { EnvironmentControlConfig, ManagedTarget } from "./config.ts";
import type { NamespaceResource } from "./namespaceProvisioner.ts";
import { disposeNamespace, provisionNamespace } from "./namespaceProvisioner.ts";
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
/** The port a provisioned environment serves T3 on. */
const PROVISIONED_PORT = 3000;

function isMissingSandbox(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:status\s*[:=]?\s*)?404\b|sandbox[^\n]*not found/i.test(message);
}

export interface ProvisionRequest {
  readonly provider: "e2b" | "namespace";
  readonly providerInstanceId: string;
  /** Agent driver selected in the local composer. */
  readonly agentDriver?: string | undefined;
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
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

export interface Provisioned {
  readonly provider: "e2b" | "namespace";
  readonly sandboxId: string;
  readonly pairingUrl: string;
  readonly projectDir: string;
  readonly namespaceResource?: NamespaceResource;
  readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
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
          { name: "CURSOR_CONFIG_DIR", value: "/home/user/.config/cursor", sensitive: false },
          { name: "HOME", value: "/home/user", sensitive: false },
        ]
      : existingInstance.environment;
  return `${JSON.stringify({
    ...settings,
    providers: {
      ...providers,
      [agentDriver]: { ...(providers[agentDriver] ?? {}), enabled: true },
    },
    providerInstances: {
      ...providerInstances,
      [providerInstanceId]: {
        ...existingInstance,
        driver: agentDriver,
        enabled: true,
        ...(environment ? { environment } : {}),
      },
    },
  })}\n`;
}

/** `owner/name`, or a github.com URL in any of its usual spellings. */
export function repositoryUrl(repository: string): string {
  const cleaned = repository.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  const [owner, name] = cleaned.split("/");
  if (!owner || !name) throw new Error(`Repository must look like owner/name, got '${repository}'`);
  return `https://github.com/${owner}/${name}.git`;
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
  auth: string,
): Promise<Provisioned> {
  const run = (command: string, timeoutMs = 180_000) =>
    sandbox.commands.run(command, { timeoutMs });

  if (request.agentDriver) {
    const settingsPath = "/home/user/.t3/userdata/settings.json";
    const existing = await sandbox.files.read(settingsPath).catch(() => "{}");
    await sandbox.files.write(
      settingsPath,
      enableChildProvider(existing, request.agentDriver, request.providerInstanceId),
    );
  }

  const selectedCredentialTarget =
    request.agentDriver === "cursor"
      ? "/home/user/.config/cursor/auth.json"
      : "/home/user/.codex/auth.json";
  await run(`mkdir -p ${NodePath.posix.dirname(selectedCredentialTarget)}`);
  await sandbox.files.write(selectedCredentialTarget, auth);
  await run(`chmod 600 ${selectedCredentialTarget}`);

  // Each agent CLI reads its sign-in from its own place, so copying those
  // files is what lets an environment run more than the one agent whose
  // credentials provisioning installs by name.
  for (const file of provisioning.homeFiles ?? []) {
    const target = NodePath.posix.join("/home/user", file.destination);
    if (target === selectedCredentialTarget) continue;
    const contents = await NodeFSP.readFile(file.source, "utf8").catch(() => {
      throw new ProvisionRefused(
        "credentials",
        `Home file '${file.source}' is configured but missing on this machine.`,
      );
    });
    await run(`mkdir -p ${NodePath.posix.dirname(target)}`);
    await sandbox.files.write(target, contents);
    await run(`chmod 600 ${target}`);
  }

  // Written to the profile rather than exported per command: an agent runs
  // these CLIs from its own shell, and nothing it starts would inherit a
  // variable set around the command that provisioned the machine.
  const shellEnvironment = provisioning.shellEnvironment ?? [];
  if (shellEnvironment.length > 0) {
    const lines: string[] = [];
    for (const variable of shellEnvironment) {
      const value = await NodeFSP.readFile(variable.source, "utf8").catch(() => {
        throw new ProvisionRefused(
          "credentials",
          `Value for '${variable.name}' is configured but missing on this machine.`,
        );
      });
      lines.push(`export ${variable.name}=${JSON.stringify(value.trim())}`);
    }
    await sandbox.files.write("/home/user/.profile.d-agents.sh", `${lines.join("\n")}\n`);
    await run("chmod 600 /home/user/.profile.d-agents.sh");
    await run(
      "grep -q profile.d-agents /home/user/.bashrc 2>/dev/null || " +
        "echo '. /home/user/.profile.d-agents.sh' >> /home/user/.bashrc",
    );
    await run(
      "grep -q profile.d-agents /home/user/.profile 2>/dev/null || " +
        "echo '. /home/user/.profile.d-agents.sh' >> /home/user/.profile",
    );
  }

  // Cloning uses a credential helper, but `gh` reads its own config, and an
  // agent that cannot reach `gh` can commit and never open a pull request.
  if (provisioning.githubToken) {
    await run("mkdir -p /home/user/.config/gh");
    await sandbox.files.write(
      "/home/user/.config/gh/hosts.yml",
      `github.com:\n    oauth_token: ${provisioning.githubToken}\n    git_protocol: https\n`,
    );
    await run("chmod 600 /home/user/.config/gh/hosts.yml");
  }

  let projectDir = "/home/user/work";
  if (request.repository) {
    if (!provisioning.githubToken)
      throw new ProvisionRefused(
        "unconfigured",
        "Cloning a repository needs a configured GitHub token.",
      );
    // A credential file keeps the token out of the clone URL, so it never
    // reaches the remote, `git remote -v`, or shell history.
    await sandbox.files.write(
      "/home/user/.git-credentials",
      `https://x-access-token:${provisioning.githubToken}@github.com\n`,
    );
    await run("chmod 600 /home/user/.git-credentials");
    await run(
      "git config --global credential.helper store && " +
        "git config --global user.email agent@t3.local && git config --global user.name t3",
    );
    projectDir = repositoryDirectory(request.repository);
    const branch = request.branch ? `--branch ${request.branch} ` : "";
    const cloned = await run(
      `mkdir -p /home/user/work && git clone --filter=blob:none ${branch}` +
        `${repositoryUrl(request.repository)} ${projectDir}`,
      900_000,
    );
    if (cloned.exitCode !== 0) throw new Error("Repository clone failed");
  } else {
    // The template already ships an initialised workspace, so this only has to
    // cover a template that does not.
    await run(
      "mkdir -p /home/user/work && cd /home/user/work && " +
        "(git rev-parse --git-dir >/dev/null 2>&1 || (git init -q && " +
        "git config user.email agent@t3.local && git config user.name t3 && " +
        "echo '# workspace' > README.md && git add -A && git commit -qm init))",
    );
  }

  // A checkout is not a working tree: whatever the repository refuses to carry
  // has to arrive separately or nothing in it runs.
  for (const file of provisioning.workspaceFiles ?? []) {
    const contents = await NodeFSP.readFile(file.source, "utf8").catch(() => {
      throw new ProvisionRefused(
        "unconfigured",
        `Workspace file '${file.source}' is configured but missing on this machine.`,
      );
    });
    const target = NodePath.posix.join(projectDir, file.destination);
    await run(`mkdir -p ${NodePath.posix.dirname(target)}`);
    await sandbox.files.write(target, contents);
    await run(`chmod 600 ${target}`);
  }

  // Without this every environment from the template calls itself by the
  // sandbox image's hostname, so a list of them reads as the same name
  // repeated and none of them can be told apart. The server prefers
  // PRETTY_HOSTNAME on Linux, and it reads it when it starts, which the
  // restart below is about to do anyway.
  const label = request.repository
    ? `${repositoryUrl(request.repository)
        .split("/")
        .pop()!
        .replace(/\.git$/, "")} · ${request.providerInstanceId}`
    : request.providerInstanceId;
  await run(
    `printf 'PRETTY_HOSTNAME=%s\\n' ${JSON.stringify(JSON.stringify(label))} | sudo tee /etc/machine-info >/dev/null`,
  ).catch(() => undefined);

  // Every sandbox from the template inherits one environment ID, and clients
  // key environments by it, so each environment has to be given its own before
  // anything pairs with it.
  //
  // The child is forked from the template's already-running server. A fork
  // keeps the process memory and page cache, so replacing the inherited server
  // after writing this ID takes seconds rather than rereading the install from
  // cold disk.
  //
  // The bracket keeps the pattern from matching the command carrying it, which
  // would otherwise make this kill its own shell.
  await run("pkill -f '[t]3 serve' || true");
  await sandbox.files.write(
    "/home/user/.t3/userdata/environment-id",
    `${globalThis.crypto.randomUUID()}\n`,
  );
  // Binding to every interface is what lets the sandbox's own hostname reach
  // the server; the environment never joins a relay.
  await sandbox.commands
    .run(
      `nohup sh -c 'cd ${projectDir} && exec t3 serve --no-browser --host 0.0.0.0 ` +
        `--port ${PROVISIONED_PORT} > /tmp/serve.out 2>&1' >/dev/null 2>&1 &`,
      { timeoutMs: 20_000, background: true },
    )
    .catch(() => undefined);
  const host = sandbox.getHost(PROVISIONED_PORT);
  const deadline = Date.now() + 600_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    await NodeTimersPromises.setTimeout(1_000);
    ready = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(5_000) })
      .then((response) => response.status === 200)
      .catch(() => false);
  }
  if (!ready) throw new Error("Provisioned environment never answered");
  await run(`t3 project add ${projectDir}`).catch(() => undefined);

  // Minted last and never spent here: the token is single use, and verifying it
  // would hand the caller a dead link.
  const paired = await run(`t3 pair --ttl 12h --label 'cloud-${request.providerInstanceId}'`);
  const token = /Token:\s*([A-Z0-9]+)/.exec(
    (paired.stdout ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""),
  )?.[1];
  if (!token) throw new Error("Could not mint a pairing token");
  return {
    provider: "e2b" as const,
    sandboxId: sandbox.sandboxId,
    pairingUrl: `https://${host}/pair#token=${token}`,
    projectDir,
  };
}

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
    provision: async (request) => {
      if (request.provider === "namespace") {
        if (!config.provisioning?.namespace)
          throw new ProvisionRefused(
            "unconfigured",
            "Namespace provisioning is not configured on this install.",
          );
        if (!config.namespaceIngressToken)
          throw new ProvisionRefused(
            "credentials",
            "Namespace provisioning needs an ingress access token to connect the private workspace URL.",
          );
        if (!namespaceRunner)
          throw new ProvisionRefused("unsupported", "Namespace provisioning is unavailable.");
        if (request.repository && !config.provisioning.githubToken)
          throw new ProvisionRefused(
            "unconfigured",
            "Cloning a repository into Namespace needs a configured GitHub token.",
          );
        const namespaceFiles: {
          source: string;
          destination: string;
          mode?: string;
        }[] = [];
        const namespaceEnvironment: { name: string; value: string }[] = [];
        if (request.agentDriver === "codex" || request.agentDriver === "cursor") {
          const authPath = accountAuthPath(request.providerInstanceId);
          await NodeFSP.access(authPath).catch(() => {
            throw new ProvisionRefused(
              "credentials",
              `No credentials for '${request.providerInstanceId}' on this machine.`,
            );
          });
          namespaceFiles.push({
            source: authPath,
            destination:
              request.agentDriver === "cursor"
                ? "/Users/runner/.config/cursor/auth.json"
                : "/Users/runner/.codex/auth.json",
            mode: "600",
          });
          if (request.agentDriver === "codex")
            namespaceEnvironment.push({ name: "CODEX_HOME", value: "/Users/runner/.codex" });
          else
            namespaceEnvironment.push(
              { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file" },
              { name: "CURSOR_CONFIG_DIR", value: "/Users/runner/.config/cursor" },
              { name: "HOME", value: "/Users/runner" },
              {
                name: "PATH",
                value: "/Users/runner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
              },
            );
        }
        for (const file of config.provisioning?.homeFiles ?? []) {
          namespaceFiles.push({ source: file.source, destination: file.destination, mode: "600" });
        }
        const prepared = await provisionNamespace(namespaceRunner, {
          ...config.provisioning.namespace,
          providerInstanceId: request.providerInstanceId,
          agentDriver: request.agentDriver,
          repository: request.repository,
          branch: request.branch,
          githubToken: config.provisioning.githubToken,
          files: namespaceFiles,
          environment: namespaceEnvironment,
          workspaceFiles: config.provisioning.workspaceFiles ?? [],
        });
        try {
          const upstream = new URL(prepared.pairingUrl);
          const proxy = await namespaceProxy.open({
            proxyId: NodeCrypto.randomUUID(),
            upstreamHttpBaseUrl: `${upstream.origin}/`,
            upstreamWsBaseUrl: `${upstream.protocol === "https:" ? "wss:" : "ws:"}//${upstream.host}/`,
            upstreamAuthorization: `Bearer ${config.namespaceIngressToken}`,
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
      const provisioning = config.provisioning;
      if (!provisioning)
        throw new ProvisionRefused(
          "unconfigured",
          "This install has no cloud provisioning template configured.",
        );
      if (!provisioning.templateId)
        throw new ProvisionRefused(
          "unconfigured",
          "E2B provisioning is not configured on this install.",
        );
      const authPath = accountAuthPath(request.providerInstanceId);
      const auth = await NodeFSP.readFile(authPath, "utf8").catch(() => {
        throw new ProvisionRefused(
          "credentials",
          `No credentials for '${request.providerInstanceId}' on this machine.`,
        );
      });

      const allowed = provisioning.egressAllow;
      const network =
        allowed && allowed.length > 0
          ? { network: { allowOut: [...allowed], denyOut: [ALL_TRAFFIC] } }
          : {};
      // The parent exists only long enough to make a memory-preserving fork.
      // Its kill timeout is a final guard if this process dies between create
      // and fork; it must never become a warm sandbox that bills while idle.
      const parent = await Sandbox.create(provisioning.templateId, {
        ...api,
        timeoutMs: 10 * 60_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { purpose: "t3-environment", account: request.providerInstanceId },
        // Denying everything first is what makes the allow list meaningful;
        // without the deny, listing hosts grants nothing and blocks nothing.
        ...network,
      });
      let sandbox: Sandbox | undefined;
      try {
        const fork = (await parent.fork({ count: 1, timeoutMs: 6 * 3_600_000 }))[0];
        if (!(fork instanceof Sandbox))
          throw new Error(`Could not fork the E2B template: ${String(fork)}`);
        sandbox = fork;
        await parent.kill();
        return await prepare(sandbox, provisioning, request, auth);
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
