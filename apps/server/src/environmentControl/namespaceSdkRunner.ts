// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
import { execFile as execFileCallback } from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
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

const repositoryUrl = (repository: string): string => {
  const cleaned = repository.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  const [owner, name] = cleaned.split("/");
  if (!owner || !name) throw new Error(`Repository must look like owner/name, got '${repository}'`);
  return `https://github.com/${owner}/${name}.git`;
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
        ...(input.repository
          ? ["--checkout", repositoryUrl(input.repository), "--setup_github"]
          : ["--no_checkout"]),
      ];
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
    },
    bootstrap: async ({ resource, projectDir, repository, branch }) => {
      if (repository === undefined) {
        const command = `mkdir -p ${JSON.stringify(projectDir)}`;
        await run(["exec", nameOf(resource), "--", "sh", "-lc", command]);
      } else if (branch !== undefined) {
        const command =
          `cd ${JSON.stringify(projectDir)} && git fetch --all --prune && ` +
          `git checkout ${JSON.stringify(branch)}`;
        await run(["exec", nameOf(resource), "--", "sh", "-lc", command]);
      }
      const command =
        `mkdir -p ${JSON.stringify(projectDir)} && cd ${JSON.stringify(projectDir)} && ` +
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
      await run(["shutdown", nameOf(resource)]);
    },
    expireDevbox: async (resource) => {
      await run(["expire", nameOf(resource), "--force"]);
    },
  };
}

export { exposedOrigin, pairToken, shapeFor };
