// @effect-diagnostics nodeBuiltinImport:off - these tests run the install command in a disposable home.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  guestProviderInstallCommand,
  guestToolInstallCommand,
  withGuestProviderInstall,
} from "./guestProviderInstall.ts";

describe("guestProviderInstallCommand", () => {
  it("installs Codex into the isolated home prefix", () => {
    expect(guestProviderInstallCommand("codex")).toBe(
      'npm install --global --no-fund --no-audit @openai/codex@latest && "$HOME/.local/bin/codex" --version',
    );
  });

  it("leaves unknown drivers without a guest install", () => {
    expect(guestProviderInstallCommand("grok")).toBeUndefined();
    expect(guestProviderInstallCommand(undefined)).toBeUndefined();
  });
});

describe("withGuestProviderInstall", () => {
  it("adds the closed install command when the selected driver has one", () => {
    expect(withGuestProviderInstall({ port: 1 }, "claudeAgent")).toEqual({
      port: 1,
      providerInstall:
        'npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest && "$HOME/.local/bin/claude" --version',
    });
  });

  it("keeps the install a manifest froze for every provisioned driver", () => {
    expect(
      withGuestProviderInstall(
        { port: 1, providerInstall: "install codex && install cursor" },
        "codex",
      ),
    ).toEqual({ port: 1, providerInstall: "install codex && install cursor" });
  });

  it("derives an older manifest's install from its driver exactly as before", () => {
    expect(withGuestProviderInstall({ port: 1 }, "cursor")).toEqual({
      port: 1,
      providerInstall:
        "curl https://cursor.com/install -fsS | bash && " +
        'test -x "$HOME/.local/bin/agent" && ' +
        'if [ ! -e "$HOME/.local/bin/cursor-agent" ]; then ln -s agent "$HOME/.local/bin/cursor-agent"; fi',
    });
  });

  it("does not add a field when there is nothing to install", () => {
    expect(withGuestProviderInstall({ port: 1 }, undefined)).toEqual({ port: 1 });
  });
});

describe("guestToolInstallCommand", () => {
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true })));
  });

  const pkg = "fixture aws pkg";
  const pins = {
    awsCli: { version: "9.9.9", sha256: NodeCrypto.createHash("sha256").update(pkg).digest("hex") },
    wrangler: "8.8.8",
  };
  // Stand-ins for the network and macOS tools; each logs its name to $HOME/calls.
  const stubs = {
    curl: `echo curl >> "$HOME/calls"; while [ "$1" != -o ]; do shift; done; printf '${pkg}' > "$2"`,
    pkgutil: `echo pkgutil >> "$HOME/calls"; mkdir -p "$3/aws-cli.pkg/Payload/aws-cli" && printf '#!/bin/sh\\necho aws-cli/9.9.9\\n' > "$3/aws-cli.pkg/Payload/aws-cli/aws" && chmod 755 "$3/aws-cli.pkg/Payload/aws-cli/aws"`,
    npm: `echo npm >> "$HOME/calls"; mkdir -p "$NPM_CONFIG_PREFIX/lib/node_modules/wrangler" && printf '{\\n  "version": "8.8.8"\\n}\\n' > "$NPM_CONFIG_PREFIX/lib/node_modules/wrangler/package.json"`,
  };

  async function makeHome() {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tool-install-"));
    homes.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "stubs"));
    await NodeFSP.mkdir(NodePath.join(home, ".local/bin"), { recursive: true });
    for (const [name, body] of Object.entries(stubs))
      await NodeFSP.writeFile(NodePath.join(home, "stubs", name), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    return home;
  }

  const install = (home: string, command = guestToolInstallCommand(pins)) =>
    NodeChildProcess.spawnSync("sh", ["-c", command], {
      env: {
        HOME: home,
        NPM_CONFIG_PREFIX: NodePath.join(home, ".local"),
        PATH: `${home}/stubs:${home}/.local/bin:/usr/bin:/bin`,
      },
      encoding: "utf8",
    });
  const calls = (home: string) =>
    NodeFSP.readFile(NodePath.join(home, "calls"), "utf8").catch(() => "");
  const aws = (home: string) =>
    NodeChildProcess.execFileSync(NodePath.join(home, ".local/bin/aws"), { encoding: "utf8" });

  it("installs both CLIs once and skips them when the pinned versions are present", async () => {
    const home = await makeHome();
    expect(install(home).status).toBe(0);
    expect(await calls(home)).toBe("curl\npkgutil\nnpm\n");
    expect(aws(home)).toBe("aws-cli/9.9.9\n");

    expect(install(home).status).toBe(0);
    expect(await calls(home)).toBe("curl\npkgutil\nnpm\n");
  });

  it("reinstalls over a download cut short and a different wrangler", async () => {
    const home = await makeHome();
    await NodeFSP.mkdir(NodePath.join(home, ".local/lib/aws-cli-9.9.9.partial/expanded"), {
      recursive: true,
    });
    await NodeFSP.mkdir(NodePath.join(home, ".local/lib/node_modules/wrangler"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(home, ".local/lib/node_modules/wrangler/package.json"),
      '{\n  "version": "8.8.7"\n}\n',
    );
    expect(install(home).status).toBe(0);
    expect(await calls(home)).toBe("curl\npkgutil\nnpm\n");
    expect(aws(home)).toBe("aws-cli/9.9.9\n");
  });

  it("refuses an AWS CLI package whose digest does not match", async () => {
    const home = await makeHome();
    const result = install(
      home,
      guestToolInstallCommand({ ...pins, awsCli: { ...pins.awsCli, sha256: "0".repeat(64) } }),
    );
    expect(result.status).not.toBe(0);
    expect(await calls(home)).toBe("curl\n");
    await expect(NodeFSP.access(NodePath.join(home, ".local/lib/aws-cli-9.9.9"))).rejects.toThrow();
  });
});
