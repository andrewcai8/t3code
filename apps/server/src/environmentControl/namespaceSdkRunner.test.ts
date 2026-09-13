// @effect-diagnostics nodeBuiltinImport:off - executes generated shell quoting without running cloud commands.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createNamespaceSdkRunner,
  exposedOrigin,
  namespaceDestination,
  pairToken,
  shapeFor,
} from "./namespaceSdkRunner.ts";

describe("Namespace runner boundary parsing", () => {
  it("parses the workspace URL returned by devbox url expose", () => {
    expect(exposedOrigin('{"urls":[{"url":"https://dbx.devbox.so/"}]}')).toBe(
      "https://dbx.devbox.so",
    );
  });

  it("parses the one-time token returned by t3 pair", () => {
    expect(pairToken("\u001b[32mToken: ABC123\u001b[0m\n")).toBe("ABC123");
    expect(() => pairToken("no token")).toThrow("did not return a token");
  });

  it("maps the supported macOS sizes to their documented shapes", () => {
    expect(shapeFor("m")).toMatchObject({ virtualCpu: 6, memoryMegabytes: 14336 });
    expect(shapeFor("l")).toMatchObject({ virtualCpu: 12, memoryMegabytes: 28672 });
  });

  it("keeps transferred files inside the Namespace runner home", () => {
    expect(namespaceDestination(".config/cursor/auth.json")).toBe(
      "/Users/runner/.config/cursor/auth.json",
    );
    expect(() => namespaceDestination("../../etc/passwd")).toThrow("escapes");
  });
});

const api = vi.hoisted(() => ({ fetch: vi.fn(), activate: vi.fn() }));
vi.mock("@namespacelabs/sdk/api", () => ({
  createClient: () => api,
  createGlobalTransport: vi.fn(),
}));

const retainedResource = {
  provider: "namespace",
  devboxId: "dbx-retained",
  devboxName: "retained",
  instanceId: "old-instance",
  region: "iad",
  workspaceDir: "/Volumes/devbox/project",
  homeDir: "/Volumes/devbox/.t3-home",
} as const;

function resumeFixture(input: { running?: boolean; healthy?: boolean; identity?: string } = {}) {
  api.fetch.mockReset().mockResolvedValue({
    devbox: { id: retainedResource.devboxId, workspaceDir: "/Users/runner/workspaces" },
    instanceId: input.running ? "live-instance" : "",
  });
  api.activate.mockReset().mockResolvedValue({ instanceId: "new-instance" });
  let healthy = input.healthy ?? false;
  const execute = vi.fn(async (args: readonly string[]) => {
    if (args.includes("cat")) return { stdout: input.identity ?? "env-retained\n", stderr: "" };
    if (args.includes("curl")) {
      if (!healthy) throw new Error("connection refused despite stale runtime file");
      return { stdout: '{"environmentId":"env-retained"}', stderr: "" };
    }
    if (args.includes("-d")) healthy = true;
    return { stdout: '{"urls":[{"url":"https://resumed.devbox.so/"}]}', stderr: "" };
  });
  return { runner: createNamespaceSdkRunner({ execute, token: "test" }), execute };
}

describe("Namespace retained resume", () => {
  it("activates the existing Devbox and restarts T3 after stale runtime files", async () => {
    const { runner, execute } = resumeFixture();
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).resolves.toEqual({
      resource: { ...retainedResource, instanceId: "new-instance" },
      upstreamOrigin: "https://resumed.devbox.so",
    });
    expect(api.activate).toHaveBeenCalledWith(
      { name: "retained", waitForReadiness: true, includeSshCredentials: false },
      { timeoutMs: 120_000 },
    );
    expect(execute.mock.calls.filter(([args]) => args.includes("-d"))).toHaveLength(1);
    expect(execute.mock.calls.flat(2).join(" ")).not.toMatch(/clone| pair |create|settings.json/);
  });

  it("keeps a healthy retained server running", async () => {
    const { runner, execute } = resumeFixture({ running: true, healthy: true });
    await runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" });
    expect(api.activate).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([args]) => args.includes("-d"))).toBe(false);
  });

  it("refuses missing or replaced Devboxes without creating anything", async () => {
    const { runner, execute } = resumeFixture();
    api.fetch.mockResolvedValue({ devbox: { id: "replacement" }, instanceId: "other" });
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).rejects.toThrow("identity");
    expect(execute).not.toHaveBeenCalled();
    api.fetch.mockRejectedValue(new Error("NotFound"));
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).rejects.toThrow("NotFound");
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("refuses a missing retained environment before starting T3", async () => {
    const { runner, execute } = resumeFixture({ identity: "other-environment" });
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).rejects.toThrow("environment identity");
    expect(execute.mock.calls.some(([args]) => args.includes("-d"))).toBe(false);
  });

  it("creates persistent Devboxes", async () => {
    const { runner, execute } = resumeFixture({ running: true });
    expect(await runner.create({ size: "m" })).toMatchObject({
      homeDir: "/Volumes/devbox/.t3-home",
      workspaceDir: "/Volumes/devbox/workspaces",
    });
    expect(execute.mock.calls[0]?.[0]).toContain("create");
    expect(execute.mock.calls[0]?.[0]).not.toContain("--ephemeral");
  });
});

it("refuses legacy Namespace resources without a persistent home", async () => {
  const { runner, execute } = resumeFixture();
  const { homeDir: _homeDir, ...legacy } = retainedResource;
  await expect(
    runner.resume({ resource: legacy, port: 3000, environmentId: "env-retained" }),
  ).rejects.toThrow("retained home");
  expect(api.fetch).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it("remaps provider credentials into the retained home and rejects traversal", () => {
  expect(namespaceDestination("/Users/runner/.codex/auth.json", "/Volumes/devbox/.t3-home")).toBe(
    "/Volumes/devbox/.t3-home/.codex/auth.json",
  );
  expect(() => namespaceDestination("../outside", "/Volumes/devbox/.t3-home")).toThrow("escapes");
});

it.each(["codex", "cursor", "claudeAgent"])(
  "bootstraps %s with durable home, tools, and T3 state",
  async (agentDriver) => {
    const { runner, execute } = resumeFixture({ healthy: true });
    await runner.bootstrap({
      resource: retainedResource,
      projectDir: retainedResource.workspaceDir,
      providerInstanceId: "provider-1",
      agentDriver,
    });
    const launch = execute.mock.calls.find(([args]) => args.includes("-d"))?.[0].at(-1);
    expect(launch).toContain("export HOME='/Volumes/devbox/.t3-home'");
    expect(launch).toContain("NPM_CONFIG_PREFIX='/Volumes/devbox/.t3-home/.local'");
    expect(launch).toContain("/Volumes/devbox/.t3-home/.local/bin");
    expect(launch).toContain("npx --yes t3@0.0.40 serve");
    expect(launch).not.toContain("/Users/runner");
  },
);

it("writes valid provider settings through the actual shell quoting", async () => {
  const { runner, execute } = resumeFixture({ healthy: true });
  const homeDir = "/Volumes/devbox/home's $(printf should-not-run)";
  await runner.bootstrap({
    resource: { ...retainedResource, homeDir },
    projectDir: retainedResource.workspaceDir,
    providerInstanceId: "provider-1",
    agentDriver: "codex",
  });
  const launch = execute.mock.calls.find(([args]) => args.includes("-d"))?.[0].at(-1);
  const nodeExpression = launch?.match(/node -e (.*) && npx /s)?.[1];
  if (!nodeExpression) throw new Error("Missing provider settings command");
  const result = await NodeUtil.promisify(NodeChildProcess.execFile)("sh", [
    "-c",
    `node() { printf '%s' "$2"; }; node -e ${nodeExpression}`,
  ]);
  const writes = new Map<string, string>();
  NodeVM.runInNewContext(result.stdout, {
    require: (name: string) => {
      if (name === "node:path") return { dirname: () => homeDir };
      if (name === "node:fs")
        return {
          readFileSync: () => "{}",
          mkdirSync: () => undefined,
          writeFileSync: (path: string, contents: string) => writes.set(path, contents),
        };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  expect(JSON.parse(writes.get(`${homeDir}/.t3/userdata/settings.json`) ?? "")).toEqual({
    providers: { codex: { enabled: true } },
    providerInstances: {
      "provider-1": {
        driver: "codex",
        enabled: true,
        environment: [{ name: "CODEX_HOME", value: `${homeDir}/.codex`, sensitive: false }],
        config: { homePath: `${homeDir}/.codex` },
      },
    },
  });
});

it("refuses creation when the persistent Devbox volume is not mounted", async () => {
  const { runner, execute } = resumeFixture({ running: true });
  execute.mockImplementation(async (args) => {
    if (args.some((arg) => arg.includes("mount |"))) throw new Error("persistent mount missing");
    return { stdout: "", stderr: "" };
  });
  await expect(runner.create({ size: "m" })).rejects.toThrow("persistent mount missing");
  expect(execute.mock.calls.at(-1)?.[0][0]).toBe("expire");
});
