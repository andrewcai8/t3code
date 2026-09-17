// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - these tests drive disposable Python, Git and HTTP processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  prepareRemoteHost,
  remotePreparationScript,
  type RemotePreparationInput,
  type RemotePreparationPort,
} from "./remotePreparation.ts";
import type { ProvisionPhase } from "./provisionTiming.ts";

const roots: string[] = [];
const pids = new Set<number>();
const sha256 = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const localPort: RemotePreparationPort = {
  executePython: ({ script, stdin }) =>
    new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn("python3", ["-c", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
      child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(stdin);
    }),
};

const fixtureCli = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const args = process.argv.slice(2);
const home = args[args.indexOf('--base-dir') + 1];
const root = path.dirname(path.dirname(home));
if (args[0] === 'auth') {
  if (fs.existsSync(path.join(root, 'fail-auth-once'))) {
    fs.unlinkSync(path.join(root, 'fail-auth-once'));
    process.exit(1);
  }
  fs.appendFileSync(path.join(root, 'issued'), 'issue\n');
  process.stdout.write('test-private-broker');
} else if (args[0] === 'project') {
  process.exit(0);
} else {
  fs.appendFileSync(path.join(root, 'started'), 'start\n');
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/t3/environment') {
      response.end(JSON.stringify({ environmentId: fs.existsSync(path.join(root, 'wrong-environment')) ? 'another-environment' : fs.readFileSync(path.join(home, 'userdata/environment-id'), 'utf8').trim() }));
    } else if (request.url === '/api/auth/session') {
      response.end(JSON.stringify({ authenticated: request.headers.authorization === 'Bearer test-private-broker' && !fs.existsSync(path.join(root, 'deny-auth')), sessionMethod: 'bearer-access-token', scopes: ['access:write'] }));
    } else if (request.url === '/stop') {
      response.end('stopped');
      server.close();
    } else {
      response.end('{}');
    }
  });
  server.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
}
`;

async function fixture(install = false): Promise<RemotePreparationInput> {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preparation-"));
  roots.push(base);
  const repository = NodePath.join(base, "source");
  await NodeFSP.mkdir(repository);
  git(repository, "init", "-q");
  await NodeFSP.writeFile(NodePath.join(repository, "README.md"), "base\n");
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  const bundle = NodePath.join(base, "bundle");
  await NodeFSP.mkdir(bundle);
  await NodeFSP.writeFile(NodePath.join(bundle, "cli.mjs"), fixtureCli);
  if (install) {
    await NodeFSP.mkdir(NodePath.join(bundle, "dependency"));
    await NodeFSP.writeFile(
      NodePath.join(bundle, "dependency/package.json"),
      JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }),
    );
    await NodeFSP.writeFile(NodePath.join(bundle, "dependency/index.js"), "module.exports = 1;\n");
    await NodeFSP.writeFile(
      NodePath.join(bundle, "package.json"),
      JSON.stringify({
        name: "fixture-runtime",
        version: "1.0.0",
        type: "module",
        dependencies: { "fixture-dependency": "file:./dependency" },
      }),
    );
    NodeChildProcess.execFileSync(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: bundle, stdio: "ignore" },
    );
  }
  const archivePath = NodePath.join(base, "t3.tar");
  NodeChildProcess.execFileSync("tar", [
    "-cf",
    archivePath,
    "-C",
    bundle,
    ...(install ? ["."] : ["cli.mjs"]),
  ]);
  const port = await new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("No test port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
  return {
    requestId: "repair-1",
    resourceIdentity: "local:test-host",
    requestHash: "a".repeat(64),
    preparationHash: "b".repeat(64),
    root: NodePath.join(base, "prepared"),
    repository: { url: repository, revision: git(repository, "rev-parse", "HEAD") },
    artifact: {
      archivePath,
      sha256: sha256(await NodeFSP.readFile(archivePath)),
      revision: "c".repeat(40),
      entrypoint: "cli.mjs",
      ...(install ? { install: "npm" as const } : {}),
    },
    runtimeExecutable: process.execPath,
    port,
    readinessTimeoutSeconds: 2,
    brokerTtl: "1h",
    files: [
      {
        scope: "workspace",
        destination: ".evidence/report.json",
        sha256: sha256("private evidence"),
        contentsBase64: Buffer.from("private evidence").toString("base64"),
      },
    ],
  };
}

afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* The test may have stopped its child already. */
    }
  }
  pids.clear();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("remote preparation subprocess", () => {
  it("installs runtime dependencies on the target host before starting", async () => {
    const input = await fixture(true);
    const ready = await prepareRemoteHost(localPort, input);
    pids.add(ready.serverPid);
    expect(
      await NodeFSP.readFile(
        NodePath.join(input.root, "artifact/node_modules/fixture-dependency/package.json"),
        "utf8",
      ),
    ).toContain('"fixture-dependency"');
    const journal = JSON.parse(
      await NodeFSP.readFile(NodePath.join(input.root, "preparation.json"), "utf8"),
    );
    expect(journal.artifactLinks["node_modules/fixture-dependency"]).toBe("../dependency");
    expect((await prepareRemoteHost(localPort, input)).serverPid).toBe(ready.serverPid);
  });

  it("reports how long each remote step took and skips the clone once the workspace exists", async () => {
    const input = await fixture();
    const first: ProvisionPhase[] = [];
    const ready = await prepareRemoteHost(localPort, input, (phase) => {
      first.push(phase);
    });
    pids.add(ready.serverPid);
    expect(first.map((phase) => phase.phase)).toEqual(
      expect.arrayContaining([
        "remote.repositoryClone",
        "remote.serverStart",
        "remote.brokerToken",
      ]),
    );
    expect(first.every((phase) => typeof phase.durationMs === "number")).toBe(true);
    const converged: ProvisionPhase[] = [];
    await prepareRemoteHost(localPort, input, (phase) => {
      converged.push(phase);
    });
    expect(converged.map((phase) => phase.phase)).toContain("remote.projectAdd");
    expect(converged.map((phase) => phase.phase)).not.toContain("remote.repositoryClone");
  });

  it("serializes concurrent retries and preserves agent commits, credentials and environment identity", async () => {
    const input = await fixture();
    const [first, concurrent] = await Promise.all([
      prepareRemoteHost(localPort, input),
      prepareRemoteHost(localPort, input),
    ]);
    pids.add(first.serverPid);
    expect(concurrent).toEqual(first);
    await NodeFSP.writeFile(NodePath.join(first.projectDir, "fix.txt"), "agent work");
    git(first.projectDir, "add", "fix.txt");
    git(
      first.projectDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fix",
    );
    await NodeFSP.writeFile(
      NodePath.join(first.projectDir, ".evidence/report.json"),
      "agent annotation",
    );
    const retry = await prepareRemoteHost(localPort, input);
    expect(retry.environmentId).toBe(first.environmentId);
    expect(retry.serverPid).toBe(first.serverPid);
    expect(retry.sourceRevision).toBe(input.repository?.revision);
    expect(retry.headRevision).toBe(git(first.projectDir, "rev-parse", "HEAD"));
    expect(retry.headRevision).not.toBe(retry.sourceRevision);
    expect(
      await NodeFSP.readFile(NodePath.join(first.projectDir, ".evidence/report.json"), "utf8"),
    ).toBe("agent annotation");
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
    expect(await NodeFSP.readFile(NodePath.join(input.root, "issued"), "utf8")).toBe("issue\n");
    expect((await NodeFSP.stat(first.brokerCredentialPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(retry)).not.toContain("test-private-broker");
    expect(
      await NodeFSP.readFile(NodePath.join(input.root, "preparation.json"), "utf8"),
    ).not.toContain("private evidence");
  });

  it("resumes an incomplete preparation without resetting the checkout", async () => {
    const input = await fixture();
    await NodeFSP.mkdir(input.root, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(input.root, "fail-auth-once"), "1");
    await expect(prepareRemoteHost(localPort, input)).rejects.toThrow("Remote preparation failed");
    await NodeFSP.writeFile(NodePath.join(input.root, "workspace/unfinished.txt"), "keep");
    const id = await NodeFSP.readFile(
      NodePath.join(input.root, "home/.t3/userdata/environment-id"),
      "utf8",
    );
    const ready = await prepareRemoteHost(localPort, input);
    pids.add(ready.serverPid);
    expect(ready.environmentId).toBe(id.trim());
    expect(await NodeFSP.readFile(NodePath.join(ready.projectDir, "unfinished.txt"), "utf8")).toBe(
      "keep",
    );
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
  });

  it("rejects changed intent and changed installed artifacts", async () => {
    const input = await fixture();
    const ready = await prepareRemoteHost(localPort, input);
    pids.add(ready.serverPid);
    await expect(
      prepareRemoteHost(localPort, { ...input, requestHash: "d".repeat(64) }),
    ).rejects.toThrow();
    await NodeFSP.writeFile(NodePath.join(input.root, "artifact/cli.mjs"), "changed");
    await expect(prepareRemoteHost(localPort, input)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
  });

  it("requires authenticated readiness, even when the server answers HTTP 200", async () => {
    const input = await fixture();
    const ready = await prepareRemoteHost(localPort, input);
    pids.add(ready.serverPid);
    await NodeFSP.writeFile(NodePath.join(input.root, "deny-auth"), "1");
    await expect(prepareRemoteHost(localPort, input)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
  });

  it("recovers a lost readiness response and restarts an exited owned server", async () => {
    const input = await fixture();
    const lostResponse: RemotePreparationPort = {
      executePython: async (request) => {
        await localPort.executePython(request);
        throw new Error("Transport disconnected after completion");
      },
    };
    await expect(prepareRemoteHost(lostResponse, input)).rejects.toThrow("Transport disconnected");
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    const response = await fetch(`http://127.0.0.1:${input.port}/stop`);
    expect(await response.text()).toBe("stopped");
    const released = await localPort.executePython({
      script:
        "import fcntl,sys\nwith open(sys.stdin.read(), 'a') as lock: fcntl.flock(lock, fcntl.LOCK_EX)",
      stdin: NodePath.join(input.root, "server.lock"),
    });
    expect(released.exitCode).toBe(0);
    pids.delete(first.serverPid);
    const restarted = await prepareRemoteHost(localPort, input);
    pids.add(restarted.serverPid);
    expect(restarted.environmentId).toBe(first.environmentId);
    expect(restarted.serverPid).not.toBe(first.serverPid);
    expect(await NodeFSP.readFile(NodePath.join(input.root, "issued"), "utf8")).toBe("issue\n");
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe(
      "start\nstart\n",
    );
  });

  it("refuses an archive whose content does not match the pinned digest", async () => {
    const input = await fixture();
    await expect(
      prepareRemoteHost(localPort, {
        ...input,
        artifact: { ...input.artifact, sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(NodeFSP.stat(NodePath.join(input.root, "started"))).rejects.toThrow();
  });

  it("recovers the preparation lock after its previous process crashes", async () => {
    const input = await fixture();
    await NodeFSP.mkdir(input.root, { mode: 0o700 });
    const child = NodeChildProcess.spawn("python3", [
      "-c",
      "import fcntl,sys\nwith open(sys.argv[1], 'a') as lock:\n fcntl.flock(lock, fcntl.LOCK_EX)\n print('locked', flush=True)\n sys.stdin.read()",
      NodePath.join(input.root, "prepare.lock"),
    ]);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    const preparation = prepareRemoteHost(localPort, input);
    child.kill("SIGKILL");
    const ready = await preparation;
    pids.add(ready.serverPid);
    expect(ready.sourceRevision).toBe(input.repository?.revision);
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
  });

  it("rejects a responding server with a different environment identity", async () => {
    const input = await fixture();
    const ready = await prepareRemoteHost(localPort, input);
    pids.add(ready.serverPid);
    await NodeFSP.writeFile(NodePath.join(input.root, "wrong-environment"), "1");
    await expect(prepareRemoteHost(localPort, input)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
  });

  it("preserves an empty workspace when no repository was requested", async () => {
    const input = { ...(await fixture()), repository: null };
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    await NodeFSP.writeFile(NodePath.join(first.projectDir, "work.txt"), "keep");
    const retry = await prepareRemoteHost(localPort, input);
    expect(retry.sourceRevision).toBeNull();
    expect(retry.headRevision).toBe(first.headRevision);
    expect(retry.environmentId).toBe(first.environmentId);
    expect(await NodeFSP.readFile(NodePath.join(first.projectDir, "work.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("closes stdin and disables git prompts so a private clone cannot hang the preparer", () => {
    expect(remotePreparationScript).toContain("stdin=subprocess.DEVNULL");
    expect(remotePreparationScript).toContain("'GIT_TERMINAL_PROMPT': '0'");
    expect(remotePreparationScript).toContain("except subprocess.TimeoutExpired");
  });

  it("fetches the workspace as a shallow partial clone instead of downloading every blob", () => {
    expect(remotePreparationScript).toContain("'protocol.version=2'");
    expect(remotePreparationScript).toContain("'--filter=blob:none'");
    expect(remotePreparationScript).toContain("'--depth=1'");
    expect(remotePreparationScript).toContain("'GIT_LFS_SKIP_SMUDGE': '1'");
    expect(remotePreparationScript).toContain("if not (stage / '.git').is_dir():");
    expect(remotePreparationScript).toContain(
      "run(['git', 'checkout', '--detach', repository['revision']], stage, git_env, timeout=600)",
    );
  });

  it("starts the guest so it publishes the cloned workspace as a project", () => {
    expect(remotePreparationScript).toContain("'start'");
    expect(remotePreparationScript).toContain("'--auto-bootstrap-project-from-cwd'");
    expect(remotePreparationScript).toContain("'T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': '1'");
    expect(remotePreparationScript).toContain("['project', 'add'");
    expect(remotePreparationScript).not.toContain("['serve'");
  });

  it("rebuilds native runtime addons with node-gyp 11 instead of the Node 24-incompatible default", () => {
    expect(remotePreparationScript).toContain("'node-gyp@11'");
    expect(remotePreparationScript).toContain("'build-essential'");
    expect(remotePreparationScript).toContain("hasInstallScript");
    expect(remotePreparationScript).toContain("npm_config_nodedir");
    expect(remotePreparationScript).toContain("node.h");
  });

  it("extracts contained relative artifact symlinks", async () => {
    const input = await fixture();
    const unpacked = NodePath.join(NodePath.dirname(input.artifact.archivePath), "with-link");
    await NodeFSP.mkdir(unpacked);
    NodeChildProcess.execFileSync("tar", ["-xf", input.artifact.archivePath, "-C", unpacked]);
    await NodeFSP.symlink("cli.mjs", NodePath.join(unpacked, "runtime"));
    const archivePath = NodePath.join(NodePath.dirname(input.artifact.archivePath), "linked.tar");
    NodeChildProcess.execFileSync("tar", ["-cf", archivePath, "-C", unpacked, "."]);
    const ready = await prepareRemoteHost(localPort, {
      ...input,
      artifact: {
        ...input.artifact,
        archivePath,
        sha256: sha256(await NodeFSP.readFile(archivePath)),
      },
    });
    pids.add(ready.serverPid);
    expect(await NodeFSP.readlink(NodePath.join(input.root, "artifact/runtime"))).toBe("cli.mjs");
  });

  it("rejects artifact symlinks that point outside the archive", async () => {
    const input = await fixture();
    const unpacked = NodePath.join(NodePath.dirname(input.artifact.archivePath), "escape");
    await NodeFSP.mkdir(unpacked);
    NodeChildProcess.execFileSync("tar", ["-xf", input.artifact.archivePath, "-C", unpacked]);
    await NodeFSP.symlink("/etc/passwd", NodePath.join(unpacked, "evil"));
    const archivePath = NodePath.join(NodePath.dirname(input.artifact.archivePath), "escape.tar");
    NodeChildProcess.execFileSync("tar", ["-cf", archivePath, "-C", unpacked, "."]);
    await expect(
      prepareRemoteHost(localPort, {
        ...input,
        artifact: {
          ...input.artifact,
          archivePath,
          sha256: sha256(await NodeFSP.readFile(archivePath)),
        },
      }),
    ).rejects.toThrow("Symlink destinations are not supported");
  });

  it("does not run npm ci when the archive already contains node_modules", async () => {
    const input = await fixture(true);
    const unpacked = NodePath.join(NodePath.dirname(input.artifact.archivePath), "prebuilt");
    await NodeFSP.mkdir(unpacked);
    NodeChildProcess.execFileSync("tar", ["-xf", input.artifact.archivePath, "-C", unpacked]);
    await NodeFSP.mkdir(NodePath.join(unpacked, "node_modules/prebuilt"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(unpacked, "node_modules/prebuilt/index.js"),
      "export default 1;\n",
    );
    const archivePath = NodePath.join(NodePath.dirname(input.artifact.archivePath), "prebuilt.tar");
    NodeChildProcess.execFileSync("tar", ["-cf", archivePath, "-C", unpacked, "."]);
    const fakeBin = NodePath.join(NodePath.dirname(input.artifact.archivePath), "fake-bin");
    await NodeFSP.mkdir(fakeBin);
    const npmShim = NodePath.join(fakeBin, "npm");
    await NodeFSP.writeFile(
      npmShim,
      `#!/bin/sh\necho invoked > "$(dirname "$0")/invoked"\nexit 1\n`,
    );
    await NodeFSP.chmod(npmShim, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${NodePath.delimiter}${previousPath}`;
    try {
      const ready = await prepareRemoteHost(localPort, {
        ...input,
        artifact: {
          ...input.artifact,
          archivePath,
          sha256: sha256(await NodeFSP.readFile(archivePath)),
        },
      });
      pids.add(ready.serverPid);
    } finally {
      process.env.PATH = previousPath;
    }
    await expect(NodeFSP.stat(NodePath.join(fakeBin, "invoked"))).rejects.toThrow();
    expect(
      await NodeFSP.readFile(
        NodePath.join(input.root, "artifact/node_modules/prebuilt/index.js"),
        "utf8",
      ),
    ).toBe("export default 1;\n");
  });

  it("resumes a leftover workspace.partial clone instead of deleting it", async () => {
    const input = await fixture();
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    const response = await fetch(`http://127.0.0.1:${input.port}/stop`);
    expect(await response.text()).toBe("stopped");
    const released = await localPort.executePython({
      script:
        "import fcntl,sys\nwith open(sys.stdin.read(), 'a') as lock: fcntl.flock(lock, fcntl.LOCK_EX)",
      stdin: NodePath.join(input.root, "server.lock"),
    });
    expect(released.exitCode).toBe(0);
    pids.delete(first.serverPid);
    const stage = NodePath.join(input.root, "workspace.partial");
    await NodeFSP.rename(first.projectDir, stage);
    await NodeFSP.writeFile(NodePath.join(stage, "partial-marker"), "keep");
    const retry = await prepareRemoteHost(localPort, input);
    pids.add(retry.serverPid);
    expect(retry.environmentId).toBe(first.environmentId);
    expect(await NodeFSP.readFile(NodePath.join(retry.projectDir, "partial-marker"), "utf8")).toBe(
      "keep",
    );
  });

  it("installs the selected provider CLI into the isolated home before starting T3", async () => {
    const input = await fixture();
    const ready = await prepareRemoteHost(localPort, {
      ...input,
      providerInstall:
        'printf "$NPM_CONFIG_PREFIX\\n$PATH" > "$HOME/install-env" && ' +
        'printf "#!/bin/sh\\nexit 0\\n" > "$HOME/.local/bin/codex" && chmod 700 "$HOME/.local/bin/codex"',
    });
    pids.add(ready.serverPid);
    const recorded = (
      await NodeFSP.readFile(NodePath.join(input.root, "home/install-env"), "utf8")
    ).split("\n");
    expect(recorded[0]).toBe(NodePath.join(input.root, "home/.local"));
    expect(recorded[1]?.split(NodePath.delimiter)[0]).toBe(
      NodePath.join(input.root, "home/.local/bin"),
    );
    await expect(
      NodeFSP.access(NodePath.join(input.root, "home/.local/bin/codex")),
    ).resolves.toBeUndefined();
  });

  it("does not start T3 when guest provider install fails", async () => {
    const input = await fixture();
    await expect(
      prepareRemoteHost(localPort, {
        ...input,
        providerInstall: "printf 'install failed' >&2; exit 7",
      }),
    ).rejects.toThrow("install failed");
    await expect(NodeFSP.access(NodePath.join(input.root, "started"))).rejects.toThrow();
  });
});
