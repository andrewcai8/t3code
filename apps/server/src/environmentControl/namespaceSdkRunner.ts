// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { createClient, createGlobalTransport } from "@namespacelabs/sdk/api";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { namespaceTokenSource } from "./namespaceAllocation.ts";
import type { NamespaceResource, NamespaceRunner } from "./namespaceProvisioner.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const isNotFound = Schema.is(Schema.Struct({ code: Schema.Literal(5) }));
const DEVBOX_API = "https://private-api.global.namespaceapis.com";

export interface NamespaceSdkRunnerOptions {
  readonly token?: string;
  readonly cli?: string;
  readonly execute?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

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
  const tokenSource = namespaceTokenSource(options.token);
  const client = createClient(
    DevBoxService,
    createGlobalTransport({ tokenSource, baseUrl: DEVBOX_API }),
  );
  return {
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
    destroyInstance: async (resource) => {
      try {
        await run(["shutdown", nameOf(resource), "--force"]);
      } catch (cause) {
        // CLI failures have no structured status. Confirm absence through the
        // provider API rather than treating any shutdown failure as success.
        try {
          await client.fetch({ id: resource.devboxId }, { timeoutMs: 30_000 });
        } catch (observedCause) {
          if (isNotFound(observedCause)) return "missing";
          throw observedCause;
        }
        throw cause;
      }
    },
    expireDevbox: async (resource) => {
      await run(["expire", nameOf(resource), "--force"]);
    },
  };
}

export { exposedOrigin };
