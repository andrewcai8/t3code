// @effect-diagnostics nodeBuiltinImport:off - these fixtures drive disposable Python, Git and HTTP processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { RemotePreparationInput, RemotePreparationPort } from "./remotePreparation.ts";

/** Teardown steps a test registers and runs in reverse after it. */
export type Cleanups = Array<() => Promise<void> | void>;

export const sha256 = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.invalid",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.invalid",
};
const gitRaw = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
export const git = (cwd: string, ...args: string[]) => gitRaw(cwd, ...args).trim();
/** Porcelain status keeps its leading column, so it is split rather than trimmed. */
export const statusLines = (tree: string) =>
  gitRaw(tree, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .sort();
export const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

export const localPort: RemotePreparationPort = {
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

/** Stands in for the T3 runtime: answers the readiness probes preparation makes. */
const fixtureCli = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const args = process.argv.slice(2);
const home = args[args.indexOf('--base-dir') + 1];
if (args[0] === 'auth') {
  process.stdout.write('test-private-broker');
} else if (args[0] === 'start') {
  http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/t3/environment') {
      response.end(JSON.stringify({ environmentId: fs.readFileSync(path.join(home, 'userdata/environment-id'), 'utf8').trim() }));
    } else if (request.url === '/api/auth/pairing-token') {
      response.end(JSON.stringify({ credential: 'pair-credential' }));
    } else if (request.url === '/api/auth/session') {
      response.end(JSON.stringify({ authenticated: request.headers.authorization === 'Bearer test-private-broker', sessionMethod: 'bearer-access-token', scopes: ['access:write'] }));
    } else {
      response.end('{}');
    }
  }).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
}
`;

export async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("No port"));
      server.close(() => resolve(address.port));
    });
  });
}

/** Namespace artifact storage as the guest sees it: a signed URL it PUTs to and GETs from. */
export async function artifactStore(cleanups: Cleanups) {
  const objects = new Map<string, Buffer>();
  const server = NodeHttp.createServer((request, response) => {
    const key = request.url ?? "";
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        response.end();
      });
      return;
    }
    const body = objects.get(key);
    response.statusCode = body ? 200 : 404;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No store address");
  return {
    url: (key: string) => `http://127.0.0.1:${address.port}/${key}`,
    object: (key: string) => objects.get(`/${key}`),
  };
}

/**
 * One machine at a time owns `mount`, the cache volume's mount point, so the
 * chat root has the same absolute path on every Mac. A departure either commits
 * the volume as the next Mac's starting state or discards it.
 */
export async function world(cleanups: Cleanups) {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-chat-state-")),
  );
  cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
  const origin = NodePath.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");
  const source = NodePath.join(base, "source");
  git(base, "clone", "-q", origin, source);
  await NodeFSP.writeFile(NodePath.join(source, "README.md"), "base\n");
  await NodeFSP.writeFile(NodePath.join(source, "remove-me.txt"), "tracked\n");
  await NodeFSP.writeFile(NodePath.join(source, "staged.txt"), "one\n");
  await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), "node_modules/\n.env*\n*.bin\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "c1");
  git(source, "push", "-q", "origin", "HEAD:main");
  const advance = async (message: string) => {
    await NodeFSP.appendFile(NodePath.join(source, "README.md"), `${message}\n`);
    await NodeFSP.writeFile(NodePath.join(source, `${message}.txt`), `${message}\n`);
    git(source, "add", ".");
    git(source, "commit", "-qm", message);
    git(source, "push", "-q", "origin", "HEAD:main");
    return git(source, "rev-parse", "HEAD");
  };

  const bundle = NodePath.join(base, "bundle");
  await NodeFSP.mkdir(bundle);
  await NodeFSP.writeFile(NodePath.join(bundle, "cli.mjs"), fixtureCli);
  const archivePath = NodePath.join(base, "t3.tar");
  NodeChildProcess.execFileSync("tar", ["-cf", archivePath, "-C", bundle, "cli.mjs"]);
  const runtimeSha256 = sha256(await NodeFSP.readFile(archivePath));

  const mount = NodePath.join(base, "volume");
  const root = NodePath.join(mount, "root");
  let committed: string | null = null;
  let generation = 0;
  let instance = 0;
  const copy = (from: string, to: string) => NodeChildProcess.execFileSync("cp", ["-Rp", from, to]);
  const stopServer = async () => {
    const recorded = await NodeFSP.readFile(NodePath.join(root, "server.json"), "utf8").catch(
      () => null,
    );
    if (recorded === null) return;
    try {
      process.kill(-JSON.parse(recorded).pid, "SIGKILL");
    } catch {
      /* Already stopped by a final save. */
    }
  };
  cleanups.push(stopServer);

  return {
    base,
    origin: `file://${origin}`,
    mount,
    root,
    runtimeSha256,
    archivePath,
    advance,
    head: () => git(source, "rev-parse", "HEAD"),
    instance: () => `mac-${instance}`,
    /** A new Mac whose volume forks the last committed state, or an empty one on a miss. */
    newMac: async (cache: "committed" | "empty" = "committed") => {
      instance += 1;
      await NodeFSP.rm(mount, { recursive: true, force: true });
      if (cache === "committed" && committed !== null) copy(committed, mount);
      else await NodeFSP.mkdir(mount);
    },
    depart: async (departure: "commit" | "abandon") => {
      await stopServer();
      if (departure === "commit") {
        committed = NodePath.join(base, `committed-${++generation}`);
        copy(mount, committed);
      }
      await NodeFSP.rm(mount, { recursive: true, force: true });
    },
    prepareInput: async (chatId: string, revision: string): Promise<RemotePreparationInput> => ({
      requestId: chatId,
      resourceIdentity: `namespace:${chatId}`,
      requestHash: sha256(chatId),
      preparationHash: "b".repeat(64),
      root,
      repository: { url: `file://${origin}`, revision },
      artifact: {
        archivePath,
        sha256: runtimeSha256,
        revision: "c".repeat(40),
        entrypoint: "cli.mjs",
      },
      runtimeExecutable: process.execPath,
      port: await freePort(),
      readinessTimeoutSeconds: 10,
      brokerTtl: "1h",
      follow: "main",
      prepareCommands: [
        'mkdir -p node_modules "$HOME/.npm" "$HOME/.local/bin" && git rev-parse HEAD > node_modules/.installed-at && echo cache > "$HOME/.npm/prepared" && echo tool > "$HOME/.local/bin/tool"',
      ],
      files: [
        {
          scope: "home",
          destination: ".claude/.credentials.json",
          sha256: sha256("claude-credential"),
          contentsBase64: Buffer.from("claude-credential").toString("base64"),
        },
      ],
    }),
  };
}

export type World = Awaited<ReturnType<typeof world>>;
