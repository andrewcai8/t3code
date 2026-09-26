// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - these tests drive disposable Python, Git and HTTP processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  checkoutDecisionScript,
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
  fs.writeFileSync(path.join(root, 'project-add-args'), JSON.stringify(args));
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

/** A second runtime build whose entrypoint bytes differ, so its archive digest differs too. */
async function secondBuild(input: RemotePreparationInput) {
  const base = NodePath.dirname(input.artifact.archivePath);
  const bundle = NodePath.join(base, "bundle-v2");
  await NodeFSP.mkdir(bundle);
  await NodeFSP.writeFile(NodePath.join(bundle, "cli.mjs"), `${fixtureCli}\n// build two\n`);
  const archivePath = NodePath.join(base, "t3-v2.tar");
  NodeChildProcess.execFileSync("tar", ["-cf", archivePath, "-C", bundle, "cli.mjs"]);
  return {
    archivePath,
    sha256: sha256(await NodeFSP.readFile(archivePath)),
    revision: "e".repeat(40),
    entrypoint: "cli.mjs",
  };
}

// The guest waits for the old server to release its lock before answering, so
// by the time prepareRemoteHost resolves the previous pid is already gone.
function exited(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
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
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(input.root, "project-add-args"), "utf8")),
    ).toEqual([
      "project",
      "add",
      "--base-dir",
      expect.any(String),
      "--title",
      "source",
      ready.projectDir,
    ]);
    const converged: ProvisionPhase[] = [];
    await prepareRemoteHost(localPort, input, (phase) => {
      converged.push(phase);
    });
    expect(converged.map((phase) => phase.phase)).toContain("remote.projectAdd");
    expect(converged.map((phase) => phase.phase)).not.toContain("remote.repositoryClone");
  });

  it("runs the repository's setup in the checkout before the server answers", async () => {
    const input = await fixture();
    const prepared: RemotePreparationInput = {
      ...input,
      prepareCommands: ["pwd > prepared-in.txt", "echo toolchain > toolchain.txt"],
    };
    const ready = await prepareRemoteHost(localPort, prepared);
    pids.add(ready.serverPid);
    // Setup belongs to the checkout, not the isolated home: a repository's
    // install command means nothing anywhere else.
    expect(
      (await NodeFSP.readFile(NodePath.join(ready.projectDir, "prepared-in.txt"), "utf8")).trim(),
    ).toBe(await NodeFSP.realpath(ready.projectDir));
    expect(await NodeFSP.readFile(NodePath.join(ready.projectDir, "toolchain.txt"), "utf8")).toBe(
      "toolchain\n",
    );
  });

  it("refuses to call a box ready when its setup failed", async () => {
    const input = await fixture();
    await expect(
      prepareRemoteHost(localPort, { ...input, prepareCommands: ["exit 3"] }),
    ).rejects.toThrow(/Preparation command failed/);
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
    // The build to converge to is runtime state, not identity: a journal
    // written before the field existed still matches.
    expect(
      (await prepareRemoteHost(localPort, { ...input, runtime: input.artifact })).serverPid,
    ).toBe(ready.serverPid);
    await NodeFSP.writeFile(NodePath.join(input.root, "artifact/cli.mjs"), "changed");
    await expect(prepareRemoteHost(localPort, input)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(input.root, "started"), "utf8")).toBe("start\n");
  });

  it("upgrades the running server to a new build and keeps the home data", async () => {
    const input = await fixture();
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    const marker = NodePath.join(input.root, "home/.t3/userdata/marker.txt");
    await NodeFSP.writeFile(marker, "threads live here");
    const runtime = await secondBuild(input);
    const phases: ProvisionPhase[] = [];
    const upgraded = await prepareRemoteHost(localPort, { ...input, runtime }, (phase) => {
      phases.push(phase);
    });
    pids.add(upgraded.serverPid);
    expect(upgraded.serverPid).not.toBe(first.serverPid);
    expect(upgraded.artifactSha256).toBe(runtime.sha256);
    expect(upgraded.t3Revision).toBe(runtime.revision);
    expect(upgraded.environmentId).toBe(first.environmentId);
    expect(phases.map((phase) => phase.phase)).toContain("remote.serverStart");
    expect(exited(first.serverPid)).toBe(true);
    expect(await NodeFSP.readFile(marker, "utf8")).toBe("threads live here");
    expect(
      await NodeFSP.readFile(
        NodePath.join(input.root, "runtime", runtime.sha256, "cli.mjs"),
        "utf8",
      ),
    ).toBe(`${fixtureCli}\n// build two\n`);
    expect(await NodeFSP.readFile(NodePath.join(input.root, "artifact/cli.mjs"), "utf8")).toBe(
      fixtureCli,
    );
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(input.root, "server.json"), "utf8")),
    ).toEqual({
      pid: upgraded.serverPid,
      sha256: runtime.sha256,
      revision: runtime.revision,
    });

    const again: ProvisionPhase[] = [];
    const converged = await prepareRemoteHost(localPort, { ...input, runtime }, (phase) => {
      again.push(phase);
    });
    expect(converged.serverPid).toBe(upgraded.serverPid);
    expect(again.map((phase) => phase.phase)).not.toContain("remote.serverStart");
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

  it("fetches the workspace as a shallow clone of the one requested commit", () => {
    expect(remotePreparationScript).toContain("'protocol.version=2'");
    expect(remotePreparationScript).toContain("'--depth=1'");
    expect(remotePreparationScript).toContain("'GIT_LFS_SKIP_SMUDGE': '1'");
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

  it("builds native addons without downloading node-gyp when npm bundles a new enough one", async () => {
    const input = await fixture();
    const base = NodePath.dirname(input.artifact.archivePath);
    const bundle = NodePath.join(base, "native");
    await NodeFSP.mkdir(NodePath.join(bundle, "addon"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(bundle, "cli.mjs"), fixtureCli);
    await NodeFSP.writeFile(
      NodePath.join(bundle, "addon/package.json"),
      JSON.stringify({
        name: "fixture-addon",
        version: "1.0.0",
        scripts: {
          install:
            "node -e \"require('fs').writeFileSync(require('path').join(process.env.INIT_CWD, 'addon-built'), 'yes')\"",
        },
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(bundle, "package.json"),
      JSON.stringify({
        name: "fixture-runtime",
        version: "1.0.0",
        type: "module",
        dependencies: { "fixture-addon": "file:./addon" },
      }),
    );
    NodeChildProcess.execFileSync(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: bundle, stdio: "ignore" },
    );
    const archivePath = NodePath.join(base, "native.tar");
    NodeChildProcess.execFileSync("tar", ["-cf", archivePath, "-C", bundle, "."]);
    const tmpdir = NodePath.join(base, "tmp");
    await NodeFSP.mkdir(tmpdir);
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpdir;
    try {
      const ready = await prepareRemoteHost(localPort, {
        ...input,
        artifact: {
          ...input.artifact,
          archivePath,
          sha256: sha256(await NodeFSP.readFile(archivePath)),
          install: "npm",
        },
      });
      pids.add(ready.serverPid);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
    expect(await NodeFSP.readFile(NodePath.join(input.root, "artifact/addon-built"), "utf8")).toBe(
      "yes",
    );
    expect(await NodeFSP.readdir(tmpdir)).not.toContain("t3-node-gyp");
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

  it("does not start T3 when the repository revision cannot be fetched", async () => {
    const input = await fixture();
    await expect(
      prepareRemoteHost(localPort, {
        ...input,
        repository: { url: input.repository!.url, revision: "d".repeat(40) },
      }),
    ).rejects.toThrow(/Preparation command failed/);
    await expect(NodeFSP.access(NodePath.join(input.root, "started"))).rejects.toThrow();
    await expect(NodeFSP.access(NodePath.join(input.root, "workspace"))).rejects.toThrow();
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

  it("finishes installing provider CLIs before the repository's setup calls them", async () => {
    const input = await fixture();
    const ready = await prepareRemoteHost(localPort, {
      ...input,
      providerInstall:
        'sleep 3 && printf "#!/bin/sh\\necho installed-cli\\n" > "$HOME/.local/bin/fixture-cli" && ' +
        'chmod 700 "$HOME/.local/bin/fixture-cli"',
      prepareCommands: ['"$HOME/.local/bin/fixture-cli" > setup-saw.txt'],
    });
    pids.add(ready.serverPid);
    expect(await NodeFSP.readFile(NodePath.join(ready.projectDir, "setup-saw.txt"), "utf8")).toBe(
      "installed-cli\n",
    );
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

/** Serves one artifact the way a signed Namespace download does: a URL, no other credential. */
async function artifactServer(body: Buffer) {
  let requests = 0;
  const server = NodeHttp.createServer((request, response) => {
    requests += 1;
    if (request.url !== "/baseline.bin") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No artifact port");
  return {
    url: `http://127.0.0.1:${address.port}/baseline.bin`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe("remote preparation artifacts", () => {
  it("fetches a configured artifact into the isolated home once, before setup consumes it", async () => {
    const body = NodeCrypto.randomBytes(3 * 1024 * 1024 + 17);
    const served = await artifactServer(body);
    try {
      const input = await fixture();
      const withArtifact: RemotePreparationInput = {
        ...input,
        artifacts: [
          { path: "baseline/xcode.bin", destination: "baseline/xcode.bin", sha256: sha256(body) },
        ],
        artifactSources: [{ path: "baseline/xcode.bin", url: served.url }],
        prepareCommands: ['test -s "$HOME/baseline/xcode.bin" && echo consumed > consumed.txt'],
      };
      const phases: ProvisionPhase[] = [];
      const ready = await prepareRemoteHost(localPort, withArtifact, (phase) => {
        phases.push(phase);
      });
      pids.add(ready.serverPid);
      const landed = NodePath.join(input.root, "home/baseline/xcode.bin");
      expect((await NodeFSP.readFile(landed)).equals(body)).toBe(true);
      expect((await NodeFSP.stat(landed)).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readFile(NodePath.join(ready.projectDir, "consumed.txt"), "utf8")).toBe(
        "consumed\n",
      );
      expect(phases.map((phase) => phase.phase)).toContain("remote.artifacts");
      expect(served.requests()).toBe(1);
      await served.close();
      // A resumed Mac keeps its volume, so the bytes it already holds are not
      // fetched again, whatever URL this attempt resolved.
      const resumed = await prepareRemoteHost(localPort, {
        ...withArtifact,
        artifactSources: [{ path: "baseline/xcode.bin", url: "http://127.0.0.1:1/expired" }],
      });
      expect(resumed.environmentId).toBe(ready.environmentId);
      expect((await NodeFSP.readFile(landed)).equals(body)).toBe(true);
    } finally {
      await served.close();
    }
  });

  it("refuses an artifact whose bytes do not match the descriptor and leaves nothing behind", async () => {
    const served = await artifactServer(Buffer.from("not the baseline"));
    try {
      const input = await fixture();
      await expect(
        prepareRemoteHost(localPort, {
          ...input,
          artifacts: [
            { path: "baseline/xcode.bin", destination: "baseline.bin", sha256: "0".repeat(64) },
          ],
          artifactSources: [{ path: "baseline/xcode.bin", url: served.url }],
        }),
      ).rejects.toThrow("Artifact download digest mismatch");
      await expect(NodeFSP.readdir(NodePath.join(input.root, "home"))).resolves.not.toContain(
        "baseline.bin.preparing",
      );
      await expect(
        NodeFSP.access(NodePath.join(input.root, "home/baseline.bin")),
      ).rejects.toThrow();
      await expect(NodeFSP.access(NodePath.join(input.root, "started"))).rejects.toThrow();
    } finally {
      await served.close();
    }
  });

  it("refuses an artifact this attempt resolved no source for", async () => {
    const input = await fixture();
    await expect(
      prepareRemoteHost(localPort, {
        ...input,
        artifacts: [
          { path: "baseline/xcode.bin", destination: "baseline.bin", sha256: "0".repeat(64) },
        ],
      }),
    ).rejects.toThrow("Artifact has no download source");
  });
});

/** Commits one new file on `branch` of the fixture's source repository and returns its SHA. */
function advance(repository: string, name: string, branch?: string) {
  if (branch) git(repository, "checkout", "-q", branch);
  NodeChildProcess.execFileSync("git", ["commit", "-q", "--allow-empty", "-m", name], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return git(repository, "rev-parse", "HEAD");
}

async function followed(follow = "HEAD") {
  const input = await fixture();
  const source = input.repository!.url;
  return {
    input: { ...input, follow },
    source,
    branch: git(source, "symbolic-ref", "--short", "HEAD"),
  };
}

describe("checkout refresh", () => {
  it("decides from where preparation placed HEAD, not from the frozen revision", async () => {
    const cases = [
      ["a", "a", true, false, "a"],
      ["a", "a", true, false, "b"],
      ["a", "a", true, true, "b"],
      ["a", "c", true, false, "b"],
      ["a", "a", false, false, "b"],
      ["a", "c", true, false, "a"],
      ["a", "b", true, false, "b"],
    ];
    const result = await localPort.executePython({
      script: `${checkoutDecisionScript}\nimport json, sys\nprint(json.dumps([checkout_action(*case) for case in json.load(sys.stdin)]))`,
      stdin: JSON.stringify(cases),
    });
    expect(JSON.parse(result.stdout)).toEqual([
      "up-to-date",
      "fast-forward",
      "behind",
      "behind",
      "behind",
      "up-to-date",
      "up-to-date",
    ]);
  });

  it("opens a box at the tip even when its revision was frozen before a later push", async () => {
    const { input, source, branch } = await followed();
    const tip = advance(source, "pushed after submit");
    const ready = await prepareRemoteHost(localPort, input);
    pids.add(ready.serverPid);
    expect(ready.sourceRevision).toBe(input.repository!.revision);
    expect(ready.headRevision).toBe(tip);
    expect(git(ready.projectDir, "rev-parse", `refs/remotes/origin/${branch}`)).toBe(tip);
  });

  it("moves an untouched box to the new tip every time it reopens", async () => {
    const { input, source } = await followed();
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    const second = advance(source, "second");
    expect((await prepareRemoteHost(localPort, input)).headRevision).toBe(second);
    const third = advance(source, "third");
    expect((await prepareRemoteHost(localPort, input)).headRevision).toBe(third);
  });

  it.each([
    ["a commit", (dir: string) => advance(dir, "fix")],
    ["an edit", (dir: string) => NodeFSP.writeFile(NodePath.join(dir, "README.md"), "edited\n")],
    ["a new file", (dir: string) => NodeFSP.writeFile(NodePath.join(dir, "notes.txt"), "draft\n")],
    ["a branch", (dir: string) => git(dir, "checkout", "-q", "-b", "thread")],
  ])("leaves %s where the thread put it and shows the tip beside it", async (_, touch) => {
    const { input, source, branch } = await followed();
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    await touch(first.projectDir);
    const head = git(first.projectDir, "rev-parse", "HEAD");
    const tip = advance(source, "upstream");
    expect((await prepareRemoteHost(localPort, input)).headRevision).toBe(head);
    expect(git(first.projectDir, "rev-parse", `refs/remotes/origin/${branch}`)).toBe(tip);
  });

  it("keeps a pinned revision where it was requested", async () => {
    const input = await fixture();
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    advance(input.repository!.url, "upstream");
    expect((await prepareRemoteHost(localPort, input)).headRevision).toBe(
      input.repository!.revision,
    );
  });

  it("follows a named branch and still opens once that branch is deleted", async () => {
    const { input, source, branch } = await followed("feature");
    git(source, "checkout", "-q", "-b", "feature");
    const first = await prepareRemoteHost(localPort, input);
    pids.add(first.serverPid);
    const tip = advance(source, "feature work");
    expect((await prepareRemoteHost(localPort, input)).headRevision).toBe(tip);
    advance(source, "default moved on", branch);
    git(source, "branch", "-D", "feature");
    expect((await prepareRemoteHost(localPort, input)).headRevision).toBe(tip);
  });
});
