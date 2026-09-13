// @effect-diagnostics nodeBuiltinImport:off - executes generated shell quoting without running cloud commands.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { resolveServerConfig } from "../cli/config.ts";
import { provisionNamespace } from "./namespaceProvisioner.ts";
import { buildNamespacePreparation } from "./ProvisioningProviderProfile.ts";
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
  return { runner: createNamespaceSdkRunner({ execute, upload: vi.fn(), token: "test" }), execute };
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
    expect(launch).toContain("npx --yes t3@0.0.40 --no-browser --auto-bootstrap-project-from-cwd");
    expect(launch).not.toContain("/Users/runner");
  },
);

it.each(["codex", "cursor"])(
  "writes valid %s settings through the actual shell quoting",
  async (agentDriver) => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-namespace-settings-"),
    );
    const settingsPath = NodePath.join(directory, "settings.json");
    await NodeFSP.writeFile(settingsPath, "{}", { mode: 0o644 });
    try {
      const { execute } = resumeFixture({ healthy: true });
      const homeDir = "/Volumes/devbox/home's $(printf should-not-run)";
      const uploaded = new Map<string, string>();
      const secret = "synthetic ' $(printf should-not-run)\nvalue";
      const runner = createNamespaceSdkRunner({
        execute,
        token: "test",
        upload: async (_name, source, destination) => {
          expect((await NodeFSP.stat(source)).mode & 0o777).toBe(0o600);
          uploaded.set(destination, await NodeFSP.readFile(source, "utf8"));
        },
      });
      await runner.bootstrap({
        resource: { ...retainedResource, homeDir },
        projectDir: retainedResource.workspaceDir,
        providerInstanceId: "provider-1",
        agentDriver,
        environment: [{ name: "EXTRA_TOKEN", value: secret, sensitive: true }],
      });
      expect(execute.mock.calls.flat(2).join(" ")).not.toContain(secret);
      expect(
        JSON.parse(uploaded.get(`${homeDir}/.t3/provisioning-environment.json`) ?? ""),
      ).toEqual([{ name: "EXTRA_TOKEN", value: secret, sensitive: true }]);
      const shellEnvironment = await NodeUtil.promisify(NodeChildProcess.execFile)("sh", [
        "-c",
        `${uploaded.get(`${homeDir}/.profile.d-agents.sh`)}\nprintf '%s' "$EXTRA_TOKEN"`,
      ]);
      expect(shellEnvironment.stdout).toBe(secret);
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
              readFileSync: (path: string) =>
                uploaded.get(path) ?? '{"providerInstances":{"old-account":{"driver":"codex"}}}',
              mkdirSync: () => undefined,
              writeFileSync: (path: string, contents: string, options: NodeFS.WriteFileOptions) => {
                writes.set(path, contents);
                NodeFS.writeFileSync(settingsPath, contents, options);
              },
              chmodSync: (_path: string, mode: number) => NodeFS.chmodSync(settingsPath, mode),
            };
          throw new Error(`Unexpected module ${name}`);
        },
      });
      expect((await NodeFSP.stat(settingsPath)).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readFile(settingsPath, "utf8")).toBe(
        writes.get(`${homeDir}/.t3/userdata/settings.json`),
      );
      expect(JSON.parse(writes.get(`${homeDir}/.t3/userdata/settings.json`) ?? "")).toEqual({
        providers: {
          codex: { enabled: false },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          grok: { enabled: false },
          opencode: { enabled: false },
          antigravity: { enabled: false },
        },
        providerInstances: {
          "provider-1": {
            driver: agentDriver,
            enabled: true,
            environment: [
              { name: "EXTRA_TOKEN", value: secret, sensitive: true },
              ...(agentDriver === "codex"
                ? [{ name: "CODEX_HOME", value: `${homeDir}/.codex`, sensitive: false }]
                : [
                    { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
                    { name: "CURSOR_CONFIG_DIR", value: `${homeDir}/.cursor`, sensitive: false },
                    { name: "HOME", value: homeDir, sensitive: false },
                    {
                      name: "PATH",
                      value: `${homeDir}/.local/bin:${homeDir}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
                      sensitive: false,
                    },
                  ]),
            ],
            config:
              agentDriver === "codex"
                ? { homePath: `${homeDir}/.codex` }
                : { binaryPath: `${homeDir}/.local/bin/agent` },
          },
        },
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

effectIt.effect(
  "launches with cwd project registration enabled through the actual CLI config",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-namespace-cli-")),
      );
      try {
        const { runner, execute } = resumeFixture({ healthy: true });
        yield* Effect.promise(() =>
          runner.bootstrap({
            resource: retainedResource,
            projectDir: retainedResource.workspaceDir,
            providerInstanceId: "codex",
          }),
        );
        const launch = execute.mock.calls.find(([args]) => args.includes("-d"))?.[0].at(-1);
        if (!launch) throw new Error("T3 launch was not run");
        const cliArguments = yield* Effect.promise(() =>
          NodeUtil.promisify(NodeChildProcess.execFile)("sh", [
            "-c",
            `npx() { printf '%s\\n' "$@"; }; cd() { :; }; mkdir() { :; }; ${launch}`,
          ]),
        );
        const args = new Set(cliArguments.stdout.trim().split("\n").slice(2));
        const headless = args.has("serve");
        const config = yield* resolveServerConfig(
          {
            mode: Option.none(),
            host: Option.none(),
            devUrl: Option.none(),
            bootstrapFd: Option.none(),
            logWebSocketEvents: Option.none(),
            tailscaleServeEnabled: Option.none(),
            tailscaleServePort: Option.none(),
            port: Option.some(3000),
            baseDir: Option.some(NodePath.join(directory, "state")),
            cwd: Option.some(NodePath.join(directory, "project")),
            noBrowser: Option.some(args.has("--no-browser")),
            autoBootstrapProjectFromCwd: Option.some(args.has("--auto-bootstrap-project-from-cwd")),
          },
          Option.none(),
          headless
            ? { startupPresentation: "headless", forceAutoBootstrapProjectFromCwd: false }
            : undefined,
        ).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provide(NetService.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        );
        expect(config.autoBootstrapProjectFromCwd).toBe(true);
        expect(config.cwd).toBe(NodePath.join(directory, "project"));
        expect(config.noBrowser).toBe(true);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }),
);

it.each([false, true])(
  "runs preparation with installed tools before T3 and cleans failures (profile %s)",
  async (withProfile) => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-namespace-prepare-"),
    );
    try {
      const localHome = NodePath.join(directory, "home");
      const project = NodePath.join(directory, "project");
      await NodeFSP.mkdir(NodePath.join(localHome, ".local/bin"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(localHome, ".bun/bin"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(localHome, ".bun/bin/bun"),
        "#!/bin/sh\nprintf synthetic-bun\n",
        { mode: 0o700 },
      );
      await NodeFSP.mkdir(project);
      await NodeFSP.writeFile(
        NodePath.join(project, "prepare.sh"),
        "#!/bin/sh\nset -e\nbun --version > prepared\ncodex >> prepared\nprintf done >> prepared\n",
        { mode: 0o700 },
      );
      const { execute } = resumeFixture({ healthy: true });
      const baseExecute = execute.getMockImplementation()!;
      execute.mockImplementation(async (args) => {
        const command = args.at(-1) ?? "";
        if (command.includes("npm install"))
          await NodeFSP.writeFile(
            NodePath.join(localHome, ".local/bin/codex"),
            "#!/bin/sh\nprintf installed\n",
            { mode: 0o700 },
          );
        if (command.includes("./prepare.sh") || command.includes("./fail.sh"))
          return await NodeUtil.promisify(NodeChildProcess.execFile)("sh", [
            "-c",
            command
              .replaceAll(retainedResource.homeDir, localHome)
              .replaceAll(retainedResource.workspaceDir, project),
          ]);
        if (args.includes("-d"))
          expect(await NodeFSP.readFile(NodePath.join(project, "prepared"), "utf8")).toBe(
            "synthetic-buninstalleddone",
          );
        return baseExecute(args);
      });
      const runner = createNamespaceSdkRunner({
        execute,
        token: "test",
        upload: async (_name, source, destination) => {
          const localDestination = destination.replaceAll(retainedResource.homeDir, localHome);
          await NodeFSP.mkdir(NodePath.dirname(localDestination), { recursive: true });
          await NodeFSP.writeFile(
            localDestination,
            (await NodeFSP.readFile(source, "utf8")).replaceAll(
              retainedResource.homeDir,
              localHome,
            ),
          );
        },
      });
      const { environment } = await buildNamespacePreparation(
        {
          kind: "codex",
          instanceId: ProviderInstanceId.make("codex"),
          environment: [],
          credential: {
            kind: "file",
            source: NodePath.join(directory, "auth.json"),
            destination: ".codex/auth.json",
          },
        },
        {},
      );
      await runner.bootstrap({
        resource: retainedResource,
        projectDir: retainedResource.workspaceDir,
        providerInstanceId: "codex",
        agentDriver: "codex",
        prepareCommands: ["./prepare.sh"],
        ...(withProfile ? { environment } : {}),
      });
      await NodeFSP.writeFile(NodePath.join(project, "fail.sh"), "#!/bin/sh\nexit 7\n", {
        mode: 0o700,
      });
      execute.mockClear();
      await expect(
        provisionNamespace(
          { ...runner, create: async () => retainedResource },
          {
            size: "m",
            providerInstanceId: "codex",
            agentDriver: "codex",
            prepareCommands: ["./fail.sh"],
          },
        ),
      ).rejects.toThrow();
      expect(
        execute.mock.calls.filter(([args]) => args.includes("-d") || args[0] === "url"),
      ).toEqual([]);
      expect(execute.mock.calls.slice(-2).map(([args]) => args)).toEqual([
        ["shutdown", "retained", "--force"],
        ["expire", "retained", "--force"],
      ]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it("refuses creation when the persistent Devbox volume is not mounted", async () => {
  const { runner, execute } = resumeFixture({ running: true });
  execute.mockImplementation(async (args) => {
    if (args.some((arg) => arg.includes("mount |"))) throw new Error("persistent mount missing");
    return { stdout: "", stderr: "" };
  });
  await expect(runner.create({ size: "m" })).rejects.toThrow("persistent mount missing");
  expect(execute.mock.calls.at(-1)?.[0][0]).toBe("expire");
});

it("uses the retained credential store without invoking an inherited system helper", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-git-helper-"));
  try {
    const marker = NodePath.join(directory, "inherited-helper-ran");
    const systemConfig = NodePath.join(directory, "system.gitconfig");
    const localHome = NodePath.join(directory, "home");
    await NodeFSP.mkdir(localHome);
    await NodeFSP.writeFile(
      systemConfig,
      `[credential]\n\thelper = "!f() { touch '${marker}'; }; f"\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(localHome, ".git-credentials"),
      "https://selected:synthetic@fixture.invalid\n",
    );
    const { runner, execute } = resumeFixture({ healthy: true });
    await runner.bootstrap({
      resource: retainedResource,
      projectDir: retainedResource.workspaceDir,
      providerInstanceId: "codex",
      repository: "owner/project",
      githubToken: "synthetic",
    });
    const command = execute.mock.calls
      .map(([args]) => args.at(-1))
      .find((argument) => argument?.includes("git config --global"));
    if (!command) throw new Error("Git credential configuration was not run");
    const run = NodeUtil.promisify(NodeChildProcess.execFile);
    const environment = {
      ...process.env,
      HOME: localHome,
      GIT_CONFIG_GLOBAL: NodePath.join(localHome, ".gitconfig"),
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    await run("sh", ["-c", command.replaceAll(retainedResource.homeDir, localHome)], {
      env: environment,
    });
    await run("sh", ["-c", command.replaceAll(retainedResource.homeDir, localHome)], {
      env: environment,
    });
    for (const url of [
      "git@github.com:fixture/project.git",
      "ssh://git@github.com/fixture/project.git",
    ]) {
      expect(
        (await run("git", ["ls-remote", "--get-url", url], { env: environment })).stdout.trim(),
      ).toBe("https://github.com/fixture/project.git");
    }
    expect(
      (
        await run("git", ["config", "--global", "--get-all", "url.https://github.com/.insteadOf"], {
          env: environment,
        })
      ).stdout
        .trim()
        .split("\n"),
    ).toEqual(["git@github.com:", "ssh://git@github.com/"]);
    const result = await run(
      "sh",
      ["-c", "printf 'protocol=https\\nhost=fixture.invalid\\n\\n' | git credential fill"],
      { env: environment },
    );
    expect(result.stdout).toContain("username=selected\npassword=synthetic");
    expect(
      await NodeFSP.stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("transfers selected auth once when a generic home file names the same destination", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-namespace-auth-"));
  try {
    const selected = NodePath.join(directory, "selected.json");
    const generic = NodePath.join(directory, "generic.json");
    await NodeFSP.writeFile(selected, '{"account":"selected"}');
    await NodeFSP.writeFile(generic, '{"account":"generic"}');
    const prepared = await buildNamespacePreparation(
      {
        kind: "cursor",
        instanceId: ProviderInstanceId.make("cursor_work"),
        environment: [],
        credential: { kind: "file", source: selected, destination: ".cursor/auth.json" },
      },
      { homeFiles: [{ source: generic, destination: "/Users/runner/.cursor/./auth.json" }] },
    );
    const { execute } = resumeFixture({ healthy: true });
    const uploaded: string[] = [];
    const runner = createNamespaceSdkRunner({
      execute,
      token: "test",
      upload: async (_name, source, destination) => {
        if (destination.endsWith("/auth.json"))
          uploaded.push(await NodeFSP.readFile(source, "utf8"));
      },
    });
    await runner.bootstrap({
      resource: retainedResource,
      projectDir: retainedResource.workspaceDir,
      providerInstanceId: "cursor_work",
      agentDriver: "cursor",
      ...prepared,
    });
    expect(uploaded).toEqual(['{"account":"selected"}']);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
