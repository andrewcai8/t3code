// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { fromBearerToken, loadUserToken } from "@namespacelabs/sdk/auth";
import { createClient, createGlobalTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { ArtifactsService } from "@namespacelabs/sdk/proto/namespace/cloud/storage/v1beta/artifact_pb";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  namespaceT3Port,
  type NamespaceResource,
  type NamespaceRunner,
} from "./namespaceProvisioner.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const DEVBOX_API = "https://private-api.global.namespaceapis.com";
const ARTIFACTS_API = "https://ord.storage.namespaceapis.com";

export interface NamespaceSdkRunnerOptions {
  readonly token?: string;
  readonly cli?: string;
  readonly execute?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  readonly upload?: (name: string, source: string, destination: string) => Promise<void>;
}

const shapeFor = (size: string) => ({
  virtualCpu: size === "l" ? 12 : 6,
  memoryMegabytes: size === "l" ? 28672 : 14336,
  machineArch: "arm64",
  os: "macos",
  selectors: [],
});

const pairToken = (output: string): string => {
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const token = clean.match(/^Token:\s*([A-Z0-9]+)\s*$/im)?.[1];
  if (!token) throw new Error("Namespace T3 pairing did not return a token");
  return token;
};

const exposedOrigin = (output: string): string => {
  const parsed: unknown = JSON.parse(output);
  const urls =
    typeof parsed === "object" && parsed !== null ? (parsed as { urls?: unknown }).urls : undefined;
  const first = Array.isArray(urls) ? urls[0] : undefined;
  if (
    typeof first !== "object" ||
    first === null ||
    typeof (first as { url?: unknown }).url !== "string"
  )
    throw new Error("Namespace URL exposure did not return a URL");
  return (first as { url: string }).url.replace(/\/$/, "");
};

const nameOf = (resource: NamespaceResource): string => resource.devboxName ?? resource.devboxId;

const namespaceDestination = (
  destination: string,
  homeDir = "/Users/runner",
  projectDir?: string,
): string => {
  const relative = destination.startsWith("/Users/runner/")
    ? destination.slice("/Users/runner/".length)
    : destination;
  const resolved = NodePath.posix.resolve(homeDir, relative);
  if (
    resolved !== homeDir &&
    !resolved.startsWith(`${homeDir}/`) &&
    !(projectDir && resolved.startsWith(`${projectDir}/`))
  )
    throw new Error(`Namespace file destination escapes the retained workspace: ${destination}`);
  return resolved;
};

const repositoryUrl = (repository: string): string => {
  const cleaned = repository.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  const [owner, name] = cleaned.split("/");
  if (!owner || !name) throw new Error(`Repository must look like owner/name, got '${repository}'`);
  return `https://github.com/${owner}/${name}.git`;
};

const namespaceProviderSettings = (
  homeDir: string,
  agentDriver: string,
  providerInstanceId: string,
): string => {
  const environment =
    agentDriver === "codex"
      ? [{ name: "CODEX_HOME", value: `${homeDir}/.codex`, sensitive: false }]
      : agentDriver === "cursor"
        ? [
            { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
            { name: "CURSOR_CONFIG_DIR", value: `${homeDir}/.cursor`, sensitive: false },
            { name: "HOME", value: homeDir, sensitive: false },
            {
              name: "PATH",
              value: runtimePath(homeDir),
              sensitive: false,
            },
          ]
        : agentDriver === "claudeAgent"
          ? [{ name: "CLAUDE_CONFIG_DIR", value: `${homeDir}/.claude`, sensitive: false }]
          : [];
  const settings = {
    driver: agentDriver,
    enabled: true,
    environment,
    ...(agentDriver === "codex" ? { config: { homePath: `${homeDir}/.codex` } } : {}),
    ...(agentDriver === "cursor" ? { config: { binaryPath: `${homeDir}/.local/bin/agent` } } : {}),
    ...(agentDriver === "claudeAgent" ? { config: { homePath: `${homeDir}/.claude` } } : {}),
  };
  const disabledProviders = Object.fromEntries(
    Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((driver) => [driver, { enabled: false }]),
  );
  return `const fs=require("node:fs");const p=${JSON.stringify(`${homeDir}/.t3/userdata/settings.json`)};let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};let e=[];try{e=JSON.parse(fs.readFileSync(${JSON.stringify(`${homeDir}/.t3/provisioning-environment.json`)},"utf8"))}catch{};const i=${JSON.stringify(settings)};i.environment=[...new Map([...e,...(i.environment||[])].map(v=>[v.name,v])).values()];s.providers=${JSON.stringify(disabledProviders)};s.providerInstances={[${JSON.stringify(providerInstanceId)}]:i};fs.mkdirSync(require("node:path").dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s)+"\\n",{mode:0o600});fs.chmodSync(p,0o600)`;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const runtimePath = (homeDir: string): string =>
  `${homeDir}/.local/bin:${homeDir}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

function retainedHome(resource: NamespaceResource): string {
  if (!resource.homeDir?.startsWith("/Volumes/"))
    throw new Error(
      "Namespace lease has no retained home; resume cannot preserve this environment",
    );
  return resource.homeDir;
}

function runtimeShell(homeDir: string, command: string): string {
  return (
    `export HOME=${shellQuote(homeDir)} PATH=${shellQuote(runtimePath(homeDir))} NPM_CONFIG_PREFIX=${shellQuote(`${homeDir}/.local`)} NODE_OPTIONS=${shellQuote("--max-old-space-size=4096")}; ` +
    `if [ -f "$HOME/.profile.d-agents.sh" ]; then . "$HOME/.profile.d-agents.sh"; fi; ` +
    command
  );
}

async function readRetainedCliInstaller(): Promise<string> {
  const candidates = [
    NodeURL.fileURLToPath(
      new URL("../../../../scripts/cloud/install-retained-cli.sh", import.meta.url),
    ),
    NodePath.resolve(process.cwd(), "scripts/cloud/install-retained-cli.sh"),
  ];
  for (const candidate of candidates) {
    try {
      return await NodeFSP.readFile(candidate, "utf8");
    } catch {
      continue;
    }
  }
  throw new Error("Namespace retained CLI installer is missing");
}

async function healthyT3(
  run: NonNullable<NamespaceSdkRunnerOptions["execute"]>,
  name: string,
  port: number,
  environmentId?: string,
): Promise<boolean> {
  try {
    const result = await run([
      "exec",
      name,
      "--",
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "5",
      `http://127.0.0.1:${port}/.well-known/t3/environment`,
    ]);
    const descriptor: unknown = JSON.parse(result.stdout);
    return (
      typeof descriptor === "object" &&
      descriptor !== null &&
      "environmentId" in descriptor &&
      typeof descriptor.environmentId === "string" &&
      (environmentId === undefined || descriptor.environmentId === environmentId)
    );
  } catch {
    return false;
  }
}

async function waitForT3(
  run: NonNullable<NamespaceSdkRunnerOptions["execute"]>,
  name: string,
  port: number,
  environmentId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await healthyT3(run, name, port, environmentId)) return;
    await NodeTimersPromises.setTimeout(1_000);
  }
  throw new Error("Namespace T3 server did not become ready");
}

export function createNamespaceSdkRunner(options: NamespaceSdkRunnerOptions = {}): NamespaceRunner {
  const cli = options.cli ?? "devbox";
  const run =
    options.execute ??
    (async (args: readonly string[]) => {
      const result = await execFile(cli, [...args], { maxBuffer: 8 * 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  const upload =
    options.upload ??
    (async (name: string, source: string, destination: string) => {
      await execFile(cli, ["upload", name, source, destination, "--mkdir"], {
        maxBuffer: 8 * 1024 * 1024,
      });
    });
  const tokenSource = options.token
    ? fromBearerToken(options.token)
    : {
        issueToken: async (minDuration: number, force?: boolean) =>
          (await loadUserToken()).issueToken(minDuration, force),
      };
  const client = createClient(
    DevBoxService,
    createGlobalTransport({ tokenSource, baseUrl: DEVBOX_API }),
  );
  const resolveArtifact = async (path: string) => {
    const artifacts = createClient(
      ArtifactsService,
      createGlobalTransport({ tokenSource, baseUrl: ARTIFACTS_API }),
    );
    const result = await artifacts.resolveArtifact(
      { namespace: "main", path },
      { timeoutMs: 30_000 },
    );
    return result.signedDownloadUrl;
  };
  return {
    create: async (input) => {
      const name = `t3-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const createArgs = [
        "create",
        "--name",
        name,
        "--activate",
        "--platform",
        "macos/arm64",
        "--size",
        input.size,
        "--image",
        "tahoe-xcode-26.4.x-latest",
        ...(input.region ? ["--site", input.region] : []),
        ...(input.idleTimeoutMinutes
          ? ["--auto_stop_idle_timeout", `${input.idleTimeoutMinutes}m`]
          : []),
        "--no_checkout",
      ];
      try {
        await run(createArgs);
        const created = await client.fetch(
          { name, returnActivatedInstance: true },
          { timeoutMs: 60_000 },
        );
        if (!created.devbox || !created.instanceId)
          throw new Error("Namespace did not return an activated Devbox");
        // workspaceDir in the API is the image's transient checkout location.
        const volumeRoot = "/Volumes/devbox";
        await run([
          "exec",
          name,
          "--",
          "sh",
          "-lc",
          "test -d /Volumes/devbox && mount | grep -F ' on /Volumes/devbox (' > /dev/null",
        ]);
        return {
          provider: "namespace",
          devboxId: created.devbox.id,
          devboxName: created.devbox.name || name,
          instanceId: created.instanceId,
          t3Port: 3001,
          region: created.devbox.site || input.region || "iad",
          homeDir: `${volumeRoot}/.t3-home`,
          workspaceDir: input.repository
            ? `${volumeRoot}/${repositoryUrl(input.repository)
                .split("/")
                .pop()!
                .replace(/\.git$/, "")}`
            : `${volumeRoot}/workspaces`,
        };
      } catch (cause) {
        await run(["expire", name, "--force"]).catch(() => undefined);
        throw cause;
      }
    },
    resume: async ({ resource, port, environmentId }) => {
      const homeDir = retainedHome(resource);
      const name = nameOf(resource);
      const retained = await client.fetch(
        { name, returnActivatedInstance: true },
        { timeoutMs: 60_000 },
      );
      if (!retained.devbox || retained.devbox.id !== resource.devboxId)
        throw new Error("Namespace retained Devbox is missing or has changed identity");
      const instanceId =
        retained.instanceId ||
        (
          await client.activate(
            { name, waitForReadiness: true, includeSshCredentials: false },
            { timeoutMs: 120_000 },
          )
        ).instanceId;
      if (!instanceId) throw new Error("Namespace did not return an activated Devbox");
      const identity = await run([
        "exec",
        name,
        "--",
        "cat",
        `${homeDir}/.t3/userdata/environment-id`,
      ]);
      if (!environmentId || identity.stdout.trim() !== environmentId)
        throw new Error("Namespace retained T3 environment identity does not match");
      if (!(await healthyT3(run, name, port, environmentId))) {
        await run([
          "exec",
          "-d",
          name,
          "--",
          "sh",
          "-lc",
          runtimeShell(
            homeDir,
            `cd ${shellQuote(resource.workspaceDir)} && npx --yes t3@0.0.40 serve --no-browser --host 0.0.0.0 --port ${port}`,
          ),
        ]);
        await waitForT3(run, name, port, environmentId);
      }
      const exposure = await run([
        "url",
        "expose",
        name,
        "--port",
        String(port),
        "--access",
        "workspace",
        "-o",
        "json",
      ]);
      return {
        resource: { ...resource, instanceId },
        upstreamOrigin: exposedOrigin(exposure.stdout),
      };
    },
    bootstrap: async ({
      resource,
      projectDir,
      providerInstanceId,
      agentDriver,
      repository,
      branch,
      githubToken,
      files = [],
      environment = [],
      prepareCommands = [],
      verifyCommands = [],
      artifacts = [],
    }) => {
      const homeDir = retainedHome(resource);
      const runInHome = (args: readonly string[]) => {
        const commandIndex = args.indexOf("-lc") + 1;
        return run(
          args.map((arg, index) => (index === commandIndex ? runtimeShell(homeDir, arg) : arg)),
        );
      };
      await run(["exec", nameOf(resource), "--", "mkdir", "-p", homeDir]);
      if (githubToken) {
        const temporaryDir = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-namespace-gh-"),
        );
        const credentials = NodePath.join(temporaryDir, "hosts.yml");
        try {
          await NodeFSP.writeFile(
            credentials,
            `github.com:\n    oauth_token: ${githubToken}\n    git_protocol: https\n`,
            { mode: 0o600 },
          );
          await upload(nameOf(resource), credentials, `${homeDir}/.config/gh/hosts.yml`);
        } finally {
          await NodeFSP.rm(temporaryDir, { recursive: true, force: true });
        }
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          'chmod 600 "$HOME/.config/gh/hosts.yml"',
        ]);
      }
      if (repository === undefined) {
        const command = `mkdir -p ${shellQuote(projectDir)}`;
        await runInHome(["exec", nameOf(resource), "--", "sh", "-lc", command]);
      } else {
        if (!githubToken) throw new Error("Namespace repository checkout needs a GitHub token");
        const temporaryDir = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-namespace-git-"),
        );
        const credentials = NodePath.join(temporaryDir, "git-credentials");
        await NodeFSP.writeFile(credentials, `https://x-access-token:${githubToken}@github.com\n`, {
          mode: 0o600,
        });
        try {
          await upload(nameOf(resource), credentials, `${homeDir}/.git-credentials`);
        } finally {
          await NodeFSP.rm(temporaryDir, { recursive: true, force: true });
        }
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          'chmod 600 "$HOME/.git-credentials" && ' +
            'git config --global --replace-all credential.helper "" && git config --global --add credential.helper store && ' +
            "git config --global --fixed-value --replace-all url.https://github.com/.insteadOf git@github.com: git@github.com: && " +
            "git config --global --fixed-value --replace-all url.https://github.com/.insteadOf ssh://git@github.com/ ssh://git@github.com/",
        ]);
        const clone =
          `mkdir -p ${shellQuote(NodePath.posix.dirname(projectDir))} && ` +
          `(test -d ${shellQuote(projectDir + "/.git")} || git clone --filter=blob:none ${shellQuote(repositoryUrl(repository))} ${shellQuote(projectDir)})`;
        await runInHome(["exec", nameOf(resource), "--", "sh", "-lc", clone]);
        if (branch !== undefined) {
          const command =
            `cd ${shellQuote(projectDir)} && git fetch --all --prune && ` +
            `git checkout ${shellQuote(branch)}`;
          await runInHome(["exec", nameOf(resource), "--", "sh", "-lc", command]);
        }
      }
      const filePermissions: string[] = [];
      for (const file of files) {
        await NodeFSP.access(file.source);
        const destination = namespaceDestination(file.destination, homeDir, projectDir);
        await upload(nameOf(resource), file.source, destination);
        filePermissions.push(`chmod ${file.mode ?? "600"} ${shellQuote(destination)}`);
      }
      if (filePermissions.length > 0) {
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          filePermissions.join(" && "),
        ]);
      }
      for (const artifact of artifacts) {
        const destination = namespaceDestination(artifact.destination, homeDir, projectDir);
        let url: URL;
        try {
          url = new URL(await resolveArtifact(artifact.path));
        } catch {
          throw new Error("Namespace preparation artifact could not be resolved");
        }
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("Namespace preparation artifact requires a private HTTPS download URL");
        const temporaryDir = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-namespace-artifact-"),
        );
        const guestDirectory = `${homeDir}/.t3/artifact-${crypto.randomUUID()}`;
        const guestConfig = `${guestDirectory}/download.curl`;
        const partial = `${destination}.t3-${crypto.randomUUID()}`;
        const localConfig = NodePath.join(temporaryDir, "download.curl");
        try {
          await NodeFSP.writeFile(
            localConfig,
            `url = ${JSON.stringify(url.href)}\nfail\nsilent\nlocation\nproto = "=https"\nproto-redir = "=https"\nconnect-timeout = 30\nmax-time = 1800\n`,
            { mode: 0o600 },
          );
          await run([
            "exec",
            nameOf(resource),
            "--",
            "sh",
            "-lc",
            `mkdir -p ${shellQuote(guestDirectory)} && chmod 700 ${shellQuote(guestDirectory)}`,
          ]);
          await upload(nameOf(resource), localConfig, guestConfig);
          const cleanup = `rm -rf ${shellQuote(guestDirectory)}; rm -f ${shellQuote(partial)}`;
          const download =
            `set -eu; umask 077; trap ${shellQuote(cleanup)} EXIT; ` +
            `chmod 600 ${shellQuote(guestConfig)}; mkdir -p ${shellQuote(NodePath.posix.dirname(destination))}; ` +
            `curl --disable --config ${shellQuote(guestConfig)} --output ${shellQuote(partial)} || { echo 'Namespace artifact download failed' >&2; exit 1; }; ` +
            `actual=$(shasum -a 256 ${shellQuote(partial)}); ` +
            `test "\${actual%% *}" = ${shellQuote(artifact.sha256)} || { echo 'Namespace artifact SHA256 mismatch' >&2; exit 1; }; ` +
            `test ! -d ${shellQuote(destination)}; mv -f ${shellQuote(partial)} ${shellQuote(destination)}`;
          await run(["exec", nameOf(resource), "--", "sh", "-lc", download]);
        } finally {
          await Promise.all([
            NodeFSP.rm(temporaryDir, { recursive: true, force: true }),
            run(["exec", nameOf(resource), "--", "rm", "-rf", guestDirectory, partial]),
          ]);
        }
      }
      if (environment.length > 0) {
        const retainedEnvironment = environment.map(({ name, value, sensitive }) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error("Namespace environment variable name is invalid");
          const retainedValue = [
            "HOME",
            "PATH",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CURSOR_CONFIG_DIR",
            "XDG_CONFIG_HOME",
          ].includes(name)
            ? value.replaceAll("/Users/runner", homeDir)
            : value;
          return { name, value: retainedValue, sensitive: sensitive ?? false };
        });
        const lines = retainedEnvironment.map(
          ({ name, value }) => `export ${name}=${shellQuote(value)}`,
        );
        const temporaryDir = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-namespace-env-"),
        );
        const temporaryFile = NodePath.join(temporaryDir, "profile.d-agents.sh");
        const temporaryEnvironment = NodePath.join(temporaryDir, "environment.json");
        await NodeFSP.writeFile(temporaryFile, `${lines.join("\n")}\n`, { mode: 0o600 });
        await NodeFSP.writeFile(temporaryEnvironment, JSON.stringify(retainedEnvironment), {
          mode: 0o600,
        });
        try {
          await upload(nameOf(resource), temporaryFile, `${homeDir}/.profile.d-agents.sh`);
          await upload(
            nameOf(resource),
            temporaryEnvironment,
            `${homeDir}/.t3/provisioning-environment.json`,
          );
        } finally {
          await NodeFSP.rm(temporaryDir, { recursive: true, force: true });
        }
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          'chmod 600 "$HOME/.profile.d-agents.sh" "$HOME/.t3/provisioning-environment.json"',
        ]);
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          `grep -q profile.d-agents "$HOME/.zprofile" 2>/dev/null || echo '. "$HOME/.profile.d-agents.sh"' >> "$HOME/.zprofile"`,
        ]);
      }
      const providerSetup = agentDriver
        ? `node -e ${shellQuote(namespaceProviderSettings(homeDir, agentDriver, providerInstanceId))} && `
        : "";
      const providerInstall =
        agentDriver === "codex"
          ? "npm install --global --no-fund --no-audit @openai/codex@latest"
          : agentDriver === "cursor"
            ? "curl https://cursor.com/install -fsS | bash && " +
              'test -x "$HOME/.local/bin/agent" && ' +
              'if [ ! -e "$HOME/.local/bin/cursor-agent" ]; then ln -s agent "$HOME/.local/bin/cursor-agent"; fi'
            : agentDriver === "claudeAgent"
              ? "npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest"
              : "";
      if (providerInstall)
        await runInHome(["exec", nameOf(resource), "--", "sh", "-lc", providerInstall]);
      const retainedCliInstaller = `${homeDir}/.t3/install-retained-cli.sh`;
      const retainedPrefix = `${homeDir}/.local`;
      const installerDir = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-namespace-retained-cli-"),
      );
      const installerSource = NodePath.join(installerDir, "install-retained-cli.sh");
      try {
        await NodeFSP.writeFile(installerSource, await readRetainedCliInstaller(), { mode: 0o600 });
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          `mkdir -p ${shellQuote(`${homeDir}/.t3`)} ${shellQuote(`${retainedPrefix}/bin`)}`,
        ]);
        await upload(nameOf(resource), installerSource, retainedCliInstaller);
      } finally {
        await NodeFSP.rm(installerDir, { recursive: true, force: true });
      }
      await runInHome([
        "exec",
        nameOf(resource),
        "--",
        "sh",
        "-lc",
        `chmod 700 ${shellQuote(retainedCliInstaller)}`,
      ]);
      await runInHome([
        "exec",
        nameOf(resource),
        "--",
        "sh",
        "-lc",
        `PREFIX=${shellQuote(retainedPrefix)} ${shellQuote(retainedCliInstaller)}`,
      ]);
      for (const command of [...prepareCommands, ...verifyCommands]) {
        await runInHome([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          `cd ${shellQuote(projectDir)} && ${command}`,
        ]);
      }
      const command =
        `mkdir -p ${shellQuote(projectDir)} && cd ${shellQuote(projectDir)} && ` +
        providerSetup +
        `npx --yes t3@0.0.40 --no-browser --auto-bootstrap-project-from-cwd --host 0.0.0.0 --port ${namespaceT3Port(resource)}`;
      const name = nameOf(resource);
      await runInHome(["exec", "-d", name, "--", "sh", "-lc", command]);
      await waitForT3(run, name, namespaceT3Port(resource));
    },
    expose: async ({ resource, port }) => {
      const name = nameOf(resource);
      const origin = exposedOrigin(
        (
          await run([
            "url",
            "expose",
            name,
            "--port",
            String(port),
            "--access",
            "workspace",
            "-o",
            "json",
          ])
        ).stdout,
      );
      const pair = await run([
        "exec",
        name,
        "--",
        "sh",
        "-lc",
        runtimeShell(
          retainedHome(resource),
          "npx --yes t3@0.0.40 pair --ttl 12h --label namespace-mac",
        ),
      ]);
      return `${origin}/pair#token=${encodeURIComponent(pairToken(pair.stdout))}`;
    },
    destroyInstance: async (resource) => {
      await run(["shutdown", nameOf(resource), "--force"]);
    },
    expireDevbox: async (resource) => {
      await run(["expire", nameOf(resource), "--force"]);
    },
  };
}

export { exposedOrigin, namespaceDestination, pairToken, shapeFor };
