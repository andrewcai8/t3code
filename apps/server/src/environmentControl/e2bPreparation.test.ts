// @effect-diagnostics nodeBuiltinImport:off - the SDK fixture runs commands in an isolated local guest directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createCloudDriver } from "./driver.ts";
import type { EnvironmentControlConfig } from "./config.ts";

const fixture = vi.hoisted(() => ({ directory: "", killed: [] as string[] }));
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
vi.mock("e2b", async (importOriginal) => {
  const actual = await importOriginal<typeof import("e2b")>();
  class Sandbox {
    readonly sandboxId: string;
    constructor(sandboxId = "child") {
      this.sandboxId = sandboxId;
    }
    static async create() {
      return new Sandbox("parent");
    }
    async fork() {
      return [new Sandbox()];
    }
    async kill() {
      fixture.killed.push(this.sandboxId);
    }
    getHost(port: number) {
      return `${port}-child.invalid`;
    }
    files = {
      write: async (path: string, contents: string) =>
        NodeFSP.writeFile(
          path.replaceAll("/home/user", fixture.directory),
          contents.replaceAll("/home/user", fixture.directory),
        ),
      read: async (path: string) =>
        NodeFSP.readFile(path.replaceAll("/home/user", fixture.directory), "utf8"),
    };
    commands = {
      run: async (command: string, options: { envs: Record<string, string> }) => {
        const env = Object.fromEntries(
          Object.entries(options.envs).map(([name, value]) => [
            name,
            value.replaceAll("/home/user", fixture.directory),
          ]),
        );
        try {
          const result = await exec(
            "/bin/sh",
            [
              "-c",
              command
                .replaceAll("/home/user", fixture.directory)
                .replaceAll("https://github.com/owner/name.git", `${fixture.directory}/source`)
                .replaceAll("sudo tee /etc/machine-info", `tee ${fixture.directory}/machine-info`),
            ],
            { env: { ...process.env, ...env } },
          );
          return { ...result, exitCode: 0 };
        } catch {
          return { stdout: "", stderr: "", exitCode: 7 };
        }
      },
    };
  }
  return { ...actual, Sandbox };
});
const config: EnvironmentControlConfig = {
  e2bApiKey: "synthetic",
  targets: [],
  broker: {
    sandboxId: "broker",
    metadata: { owner: "test" },
    url: "https://unused.invalid",
    ingressKey: "synthetic",
  },
  provisioning: { templateId: "template" },
};
let directory: string;
let capturedLog: string | undefined;
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e2b-guest-"));
  fixture.directory = directory;
  fixture.killed = [];
  await NodeFSP.mkdir(NodePath.join(directory, "source"));
  await exec("git", ["init", "-q", "--initial-branch=main", NodePath.join(directory, "source")]);
  await exec("git", [
    "-C",
    NodePath.join(directory, "source"),
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  await NodeFSP.mkdir(NodePath.join(directory, ".local/bin"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, ".local/bin/npm"),
    `#!/bin/sh
set -eu
printf 'npm %s\\n' "$*" >> "$HOME/install-invocations"
test "$NPM_CONFIG_PREFIX" = "$HOME/.local"
case "$*" in
  'install --global --no-fund --no-audit @openai/codex@latest') binary=codex ;;
  'install --global --no-fund --no-audit @anthropic-ai/claude-code@latest') binary=claude ;;
  *) exit 8 ;;
esac
printf '#!/bin/sh\\nprintf "%s fixture version\\\\n"\\n' "$binary" > "$NPM_CONFIG_PREFIX/bin/$binary"
chmod 700 "$NPM_CONFIG_PREFIX/bin/$binary"
`,
    { mode: 0o700 },
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, ".local/bin/curl"),
    `#!/bin/sh
set -eu
printf 'curl %s\\n' "$*" >> "$HOME/install-invocations"
while [ "$#" -gt 0 ]; do
  case "$1" in -o|--output) output=$2; shift ;; esac
  shift
done
cat > "$output" <<'INSTALL'
#!/bin/sh
set -eu
printf '#!/bin/sh\\nprintf "agent fixture version\\\\n"\\n' > "$HOME/.local/bin/agent"
chmod 700 "$HOME/.local/bin/agent"
INSTALL
`,
    { mode: 0o700 },
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, ".local/bin/t3"),
    '#!/bin/sh\ncase "$1" in pair) printf "Token: SYNTHETIC123\\n";; project) test -d "$3";; serve) exit 0;; esac\n',
    { mode: 0o700 },
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({
      environmentId: (
        await NodeFSP.readFile(
          NodePath.join(directory, ".t3-cloud/userdata/environment-id"),
          "utf8",
        )
      ).trim(),
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await NodeFSP.rm(directory, { recursive: true, force: true });
  if (capturedLog)
    await NodeFSP.rm(NodePath.dirname(capturedLog), { recursive: true, force: true });
  capturedLog = undefined;
});
const profile = async () => ({
  kind: "claudeAgent" as const,
  instanceId: ProviderInstanceId.make("selected"),
  environment: [
    {
      name: "ANTHROPIC_API_KEY",
      value: "literal'$(touch NEVER_EXECUTE)`echo nope`",
      sensitive: true,
    },
  ],
  credential: { kind: "environment" as const },
});

it.each([
  {
    kind: "codex",
    binary: "codex",
    installer: "npm install --global --no-fund --no-audit @openai/codex@latest",
  },
  {
    kind: "claudeAgent",
    binary: "claude",
    installer: "npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest",
  },
  { kind: "cursor", binary: "agent", installer: "curl" },
] as const)(
  "installs only the selected $kind CLI into the retained home",
  async ({ kind, binary, installer }) => {
    const driver = createCloudDriver(config, async () => ({ ...(await profile()), kind }));
    await driver.provision({ provider: "e2b", providerInstanceId: "selected" });
    const invocations = (
      await NodeFSP.readFile(NodePath.join(directory, "install-invocations"), "utf8")
    )
      .trim()
      .split("\n");
    expect(invocations).toHaveLength(1);
    if (kind === "cursor") expect(invocations[0]).toContain("https://cursor.com/install");
    else expect(invocations[0]).toBe(installer);
    const installed = await exec(
      "/bin/sh",
      [
        "-c",
        `. "$HOME/.profile.d-agents.sh"; ${binary} --version; printf '%s' "$NPM_CONFIG_PREFIX"`,
      ],
      { env: { HOME: directory, PATH: "/usr/bin:/bin" } },
    );
    expect(installed.stdout).toBe(`${binary} fixture version\n${directory}/.local`);
    expect(
      (await NodeFSP.readdir(NodePath.join(directory, ".local/bin"))).filter((name) =>
        ["agent", "claude", "codex", "cursor-agent"].includes(name),
      ),
    ).toEqual(kind === "cursor" ? ["agent", "cursor-agent"] : [binary]);
    if (kind === "cursor") {
      const settings = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(directory, ".t3-cloud/userdata/settings.json"),
          "utf8",
        ),
      );
      expect(settings.providerInstances.selected.config.binaryPath).toBe(
        `${directory}/.local/bin/agent`,
      );
    }
  },
);

it.each([
  { kind: "codex", tool: "npm" },
  { kind: "claudeAgent", tool: "npm" },
  { kind: "cursor", tool: "curl" },
] as const)(
  "keeps $kind installation failures private and stops before starting T3",
  async ({ kind, tool }) => {
    await NodeFSP.writeFile(
      NodePath.join(directory, `.local/bin/${tool}`),
      "#!/bin/sh\nprintf 'private install diagnostic' >&2\nexit 7\n",
      { mode: 0o700 },
    );
    await NodeFSP.writeFile(NodePath.join(directory, ".local/bin/agent"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    const driver = createCloudDriver(config, async () => ({ ...(await profile()), kind }));
    let message = "";
    try {
      await driver.provision({ provider: "e2b", providerInstanceId: "selected" });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("E2B provider-install failed. Private log: ");
    expect(message).not.toContain("private install diagnostic");
    capturedLog = message.split("Private log: ")[1];
    if (!capturedLog) throw new Error("Missing failure log path");
    expect(await NodeFSP.readFile(capturedLog, "utf8")).toBe("private install diagnostic");
    expect((await NodeFSP.stat(capturedLog)).mode & 0o777).toBe(0o600);
    await expect(NodeFSP.access(NodePath.join(directory, ".t3-cloud/serve.sh"))).rejects.toThrow();
    expect(fixture.killed).toContain("child");
  },
);

it("prepares and verifies before pairing with isolated T3 state and literal selected environment", async () => {
  const driver = createCloudDriver(
    {
      ...config,
      provisioning: {
        templateId: "template",
        namespace: { size: "m", prepareCommands: ["exit 99"] },
        githubToken: "synthetic",
        repositories: [
          {
            repository: "owner/name",
            e2b: {
              prepareCommands: ["printf prepared > readiness"],
              verifyCommands: [
                'test "$(cat readiness)" = prepared && printf verified >> readiness',
              ],
            },
          },
        ],
      },
    },
    profile,
  );
  const result = await driver.provision({
    provider: "e2b",
    providerInstanceId: "selected",
    agentDriver: "claudeAgent",
    repository: "owner/name",
    branch: "main",
  });
  expect(await NodeFSP.readFile(NodePath.join(directory, "work/name/readiness"), "utf8")).toBe(
    "preparedverified",
  );
  expect(result.pairingUrl).toBe("https://3001-child.invalid/pair#token=SYNTHETIC123");
  const settings = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, ".t3-cloud/userdata/settings.json"), "utf8"),
  );
  expect(settings.providerInstances.selected.driver).toBe("claudeAgent");
  expect(settings.providerInstances.selected.config.homePath).toBe(`${directory}/.claude`);
  const value = await exec("/bin/sh", [
    "-c",
    `. '${directory}/.profile.d-agents.sh'; printf '%s' "$ANTHROPIC_API_KEY"`,
  ]);
  expect(value.stdout).toBe("literal'$(touch NEVER_EXECUTE)`echo nope`");
  expect(
    await NodeFSP.stat(NodePath.join(directory, ".t3-cloud/userdata/environment-id")).then(
      () => true,
    ),
  ).toBe(true);
  expect(fixture.killed).toEqual(["parent"]);
});

it("refuses unresolved selected credentials before allocating a guest", async () => {
  const driver = createCloudDriver(config, async () => {
    throw new Error("selected account unavailable");
  });
  await expect(
    driver.provision({ provider: "e2b", providerInstanceId: "selected" }),
  ).rejects.toThrow("selected account unavailable");
  expect(fixture.killed).toEqual([]);
  expect(await NodeFSP.readdir(directory)).toEqual([".local", "source"]);
});

it("preserves a private failure log and disposes the guest without starting T3 when verification fails", async () => {
  const driver = createCloudDriver(
    {
      ...config,
      provisioning: {
        templateId: "template",
        githubToken: "synthetic",
        repositories: [
          {
            repository: "owner/name",
            e2b: {
              prepareCommands: ["printf prepared > readiness"],
              verifyCommands: ["printf 'private diagnostic'; exit 7"],
            },
          },
        ],
      },
    },
    profile,
  );
  let message = "";
  try {
    await driver.provision({
      provider: "e2b",
      providerInstanceId: "selected",
      repository: "owner/name",
    });
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }
  expect(message).toContain("E2B verify failed. Private log: ");
  expect(message).not.toContain("private diagnostic");
  capturedLog = message.split("Private log: ")[1];
  expect(capturedLog).toBeDefined();
  if (!capturedLog) throw new Error("Missing failure log path");
  expect(await NodeFSP.readFile(capturedLog, "utf8")).toBe("private diagnostic");
  expect((await NodeFSP.stat(capturedLog)).mode & 0o777).toBe(0o600);
  expect(await NodeFSP.readFile(NodePath.join(directory, "work/name/readiness"), "utf8")).toBe(
    "prepared",
  );
  await expect(NodeFSP.access(NodePath.join(directory, ".t3-cloud/serve.sh"))).rejects.toThrow();
  expect(fixture.killed).toContain("child");
});
