// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
import { execFile as execFileCallback } from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { promisify } from "node:util";
import { fromBearerToken, loadUserToken } from "@namespacelabs/sdk/auth";
import { createClient, createGlobalTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import type { NamespaceResource, NamespaceRunner } from "./namespaceProvisioner.ts";

const execFile = promisify(execFileCallback);
const DEVBOX_API = "https://private-api.global.namespaceapis.com";

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

const namespaceDestination = (destination: string): string => {
  const resolved = NodePath.posix.resolve("/Users/runner", destination);
  if (resolved !== "/Users/runner" && !resolved.startsWith("/Users/runner/"))
    throw new Error(`Namespace file destination escapes the runner home: ${destination}`);
  return resolved;
};

const repositoryUrl = (repository: string): string => {
  const cleaned = repository.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  const [owner, name] = cleaned.split("/");
  if (!owner || !name) throw new Error(`Repository must look like owner/name, got '${repository}'`);
  return `https://github.com/${owner}/${name}.git`;
};

const namespaceProviderSettings = (agentDriver: string, providerInstanceId: string): string => {
  const environment =
    agentDriver === "codex"
      ? [{ name: "CODEX_HOME", value: "/Users/runner/.codex", sensitive: false }]
      : agentDriver === "cursor"
        ? [
            { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
            { name: "CURSOR_CONFIG_DIR", value: "/Users/runner/.config/cursor", sensitive: false },
            { name: "HOME", value: "/Users/runner", sensitive: false },
            {
              name: "PATH",
              value: "/Users/runner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
              sensitive: false,
            },
          ]
        : undefined;
  const settings = {
    driver: agentDriver,
    enabled: true,
    ...(environment ? { environment } : {}),
    ...(agentDriver === "codex" ? { config: { homePath: "/Users/runner/.codex" } } : {}),
    ...(agentDriver === "cursor"
      ? { config: { binaryPath: "/Users/runner/.local/bin/agent" } }
      : {}),
  };
  return `const fs=require("node:fs");const p=${JSON.stringify("/Users/runner/.t3/userdata/settings.json")};let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};s.providers={...(s.providers||{}),[${JSON.stringify(agentDriver)}]:{...(s.providers?.[${JSON.stringify(agentDriver)}]||{}),enabled:true}};s.providerInstances={...(s.providerInstances||{}),[${JSON.stringify(providerInstanceId)}]:${JSON.stringify(settings)}};fs.mkdirSync(require("node:path").dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s)+"\\n")`;
};

async function waitForT3(
  run: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
  name: string,
): Promise<void> {
  const runtimeFiles = [
    "/Users/runner/.t3/userdata/server-runtime.json",
    "/Users/runner/.t3/dev/server-runtime.json",
  ];
  for (let attempt = 0; attempt < 120; attempt++) {
    for (const file of runtimeFiles) {
      try {
        await run(["exec", name, "--", "sh", "-lc", `test -s ${JSON.stringify(file)}`]);
        return;
      } catch {}
    }
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
  return {
    create: async (input) => {
      const name = `t3-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const createArgs = [
        "create",
        "--name",
        name,
        "--ephemeral",
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
        return {
          provider: "namespace",
          devboxId: created.devbox.id,
          devboxName: created.devbox.name || name,
          instanceId: created.instanceId,
          region: created.devbox.site || input.region || "iad",
          workspaceDir: created.devbox.workspaceDir
            ? input.repository
              ? `${created.devbox.workspaceDir}/${repositoryUrl(input.repository)
                  .split("/")
                  .pop()!
                  .replace(/\.git$/, "")}`
              : created.devbox.workspaceDir
            : "/Users/runner/workspaces",
        };
      } catch (cause) {
        await run(["expire", name, "--force"]).catch(() => undefined);
        throw cause;
      }
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
    }) => {
      if (repository === undefined) {
        const command = `mkdir -p ${JSON.stringify(projectDir)}`;
        await run(["exec", nameOf(resource), "--", "sh", "-lc", command]);
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
          await upload(nameOf(resource), credentials, "/Users/runner/.git-credentials");
        } finally {
          await NodeFSP.rm(temporaryDir, { recursive: true, force: true });
        }
        await run([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          "chmod 600 /Users/runner/.git-credentials && git config --global credential.helper store",
        ]);
        const clone =
          `mkdir -p ${JSON.stringify(NodePath.posix.dirname(projectDir))} && ` +
          `(test -d ${JSON.stringify(projectDir + "/.git")} || git clone --filter=blob:none ${JSON.stringify(repositoryUrl(repository))} ${JSON.stringify(projectDir)})`;
        await run(["exec", nameOf(resource), "--", "sh", "-lc", clone]);
        if (branch !== undefined) {
          const command =
            `cd ${JSON.stringify(projectDir)} && git fetch --all --prune && ` +
            `git checkout ${JSON.stringify(branch)}`;
          await run(["exec", nameOf(resource), "--", "sh", "-lc", command]);
        }
      }
      for (const file of files) {
        await NodeFSP.access(file.source);
        const destination = namespaceDestination(file.destination);
        await upload(nameOf(resource), file.source, destination);
        await run([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          `chmod ${file.mode ?? "600"} ${JSON.stringify(destination)}`,
        ]);
      }
      if (environment.length > 0) {
        const lines = environment.map(
          ({ name, value }) => `export ${name}=${JSON.stringify(value)}`,
        );
        const temporaryDir = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-namespace-env-"),
        );
        const temporaryFile = NodePath.join(temporaryDir, "profile.d-agents.sh");
        await NodeFSP.writeFile(temporaryFile, `${lines.join("\n")}\n`, { mode: 0o600 });
        try {
          await upload(nameOf(resource), temporaryFile, "/Users/runner/.profile.d-agents.sh");
        } finally {
          await NodeFSP.rm(temporaryDir, { recursive: true, force: true });
        }
        await run([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          "chmod 600 /Users/runner/.profile.d-agents.sh",
        ]);
        await run([
          "exec",
          nameOf(resource),
          "--",
          "sh",
          "-lc",
          "grep -q profile.d-agents /Users/runner/.zprofile 2>/dev/null || echo '. /Users/runner/.profile.d-agents.sh' >> /Users/runner/.zprofile",
        ]);
      }
      const providerSetup = agentDriver
        ? `node -e ${JSON.stringify(namespaceProviderSettings(agentDriver, providerInstanceId))} && `
        : "";
      const providerInstall =
        agentDriver === "codex"
          ? "npm install --global --no-fund --no-audit @openai/codex@latest && "
          : agentDriver === "cursor"
            ? "curl https://cursor.com/install -fsS | bash && " +
              "test -x /Users/runner/.local/bin/agent && " +
              "if [ ! -e /Users/runner/.local/bin/cursor-agent ]; then ln -s agent /Users/runner/.local/bin/cursor-agent; fi && "
            : agentDriver === "claudeAgent"
              ? "npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest && "
              : "";
      const command =
        `mkdir -p ${JSON.stringify(projectDir)} && cd ${JSON.stringify(projectDir)} && ` +
        providerInstall +
        providerSetup +
        "npx --yes t3@0.0.40 serve --no-browser --host 0.0.0.0 --port 3000";
      const name = nameOf(resource);
      await run(["exec", "-d", name, "--", "sh", "-lc", command]);
      await waitForT3(run, name);
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
        "npx --yes t3@0.0.40 pair --ttl 12h --label namespace-mac",
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
