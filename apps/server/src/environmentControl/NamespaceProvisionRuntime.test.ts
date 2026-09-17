import { ProvisionRetentionError } from "./retention.ts";
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - these tests execute the uploaded Python files, SDK HTTP requests and loopback proxy probes locally.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProvisionOperation, ProvisionResource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  makeNamespaceAccountSession,
  makeNamespaceProvisionRuntime,
  namespacePythonPort,
} from "./NamespaceProvisionRuntime.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";
import { namespaceMacImage } from "./namespaceAllocation.ts";
import { ProvisionPreparationManifest, provisionDigest } from "./ProvisionPreparation.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeExtensionRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ newDeadline: Schema.optional(Schema.String) })),
);
const decodeToken = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ bearer_token: Schema.String })),
);
const token = `e30.${Buffer.from(encodeJson({ actor_id: "user-test", tenant_id: "tenant-test", exp: 4102444800 })).toString("base64url")}.signature`;
const requestId = "7314a443-30af-4c88-bc3a-9b70940eb563";
const decodeOperation = Schema.decodeUnknownSync(ProvisionOperation);
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);
const resource = Schema.decodeUnknownSync(ProvisionResource)({
  provider: "namespace",
  devboxId: "owned-box",
  devboxName: `t3-${requestId}`,
  instanceId: "owned-instance",
  region: "iad",
  workspaceDir: "/Users/runner/workspaces",
});
if (resource.provider !== "namespace") throw new Error("Expected Namespace fixture");
const box = {
  id: "owned-box",
  name: `t3-${requestId}`,
  creator: "user-test",
  site: "iad",
  workspaceDir: "/Users/runner/workspaces",
  repository: "",
  imageRef: "",
  accessMode: "USER_PRIVATE",
  instanceShape: {
    os: "macos",
    machineArch: "arm64",
    virtualCpu: 6,
    memoryMegabytes: 14336,
    selectors: [
      { name: "macos.version", value: "26.x" },
      { name: "macos.purpose", value: "githubrunner" },
      { name: "image.with", value: "xcode-26.4.x" },
      { name: "image.with", value: "xcode-beta" },
    ],
  },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function listen(handler: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return { port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "namespace-runtime-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const state = {
    creator: "user-test",
    instanceId: "owned-instance",
    expired: false,
    duplicate: false,
    deadline: DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000),
    ),
    staleReadback: false,
    capOffset: 0,
    lifetimeCap: Number.POSITIVE_INFINITY,
    destroyed: false,
    expireOnShutdown: false,
    describedInstanceId: "owned-instance",
  };
  const apiCalls: Array<{ method: string; body: unknown }> = [];
  const api = await listen((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (data: string) => {
      body += data;
    });
    request.once("end", () => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const method = request.url?.split("/").pop() ?? "";
      apiCalls.push({ method, body: decodeJson(body) });
      response.setHeader("content-type", "application/json");
      if (state.expired) {
        response.writeHead(404).end(encodeJson({ code: "not_found", message: "gone" }));
        return;
      }
      const current = { ...box, creator: state.creator };
      if (method === "DescribeInstance") {
        response.end(
          encodeJson({
            metadata: {
              instanceId: state.describedInstanceId,
              deadline: state.deadline,
              ...(state.destroyed ? { destroyedAt: DateTime.formatIso(DateTime.nowUnsafe()) } : {}),
            },
          }),
        );
        return;
      }
      if (method === "ExtendInstance") {
        const requested = decodeExtensionRequest(body).newDeadline;
        const newDeadline = DateTime.formatIso(
          DateTime.makeUnsafe(
            (requested
              ? DateTime.toEpochMillis(DateTime.makeUnsafe(requested))
              : Math.min(
                  state.lifetimeCap,
                  DateTime.toEpochMillis(DateTime.nowUnsafe()) + 21_600_000,
                )) + state.capOffset,
          ),
        );
        if (!state.staleReadback) state.deadline = newDeadline;
        response.end(encodeJson({ newDeadline }));
        return;
      }
      response.end(
        encodeJson(
          method === "List"
            ? {
                devboxes: state.duplicate
                  ? [current, { ...current, id: "another-box" }]
                  : [current],
              }
            : method === "Update"
              ? { devbox: { ...current, busyEnsureMinimumDuration: "21600s" } }
              : { devbox: current, instanceId: state.instanceId },
        ),
      );
    });
  });
  const commands: ReadonlyArray<string>[] = [];
  const tokenFiles: string[] = [];
  const session = await makeNamespaceAccountSession({
    stateDir: directory,
    token,
    apiUrl: api.origin,
    computeApiUrl: api.origin,
    execute: async ({ args, env }) => {
      const tokenFile = env.NSC_TOKEN_FILE;
      if (!tokenFile) throw new Error("CLI had no explicit credential file");
      expect(decodeToken(await NodeFSP.readFile(tokenFile, "utf8")).bearer_token).toBe(token);
      expect((await NodeFSP.stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect((await NodeFSP.stat(NodePath.dirname(tokenFile))).mode & 0o777).toBe(0o700);
      tokenFiles.push(tokenFile);
      commands.push(args);
      if (args[0] === "upload") {
        const source = args[2];
        const target = args[3];
        if (!source || !target) throw new Error("Incomplete upload arguments");
        await NodeFSP.copyFile(source, target);
        return { exitCode: 0, stdout: "" };
      }
      if (args[0] === "exec") {
        // Any exec activates a shut-down Devbox again, on a fresh instance.
        if (state.instanceId === "") {
          state.instanceId = "woken-instance";
          state.describedInstanceId = "woken-instance";
        }
        const separator = args.indexOf("--");
        const executable = args[separator + 1];
        if (!executable) throw new Error("Missing remote executable");
        return await new Promise((resolve) => {
          NodeChildProcess.execFile(
            executable,
            args.slice(separator + 2),
            { encoding: "utf8" },
            (error, stdout, stderr) => resolve({ exitCode: error ? 1 : 0, stdout, stderr }),
          );
        });
      }
      if (args[0] === "shutdown") {
        state.instanceId = "";
        if (state.expireOnShutdown) state.expired = true;
      }
      if (args[0] === "expire") state.expired = true;
      return {
        exitCode: 0,
        stdout:
          args[0] === "url" ? encodeJson({ urls: [{ url: "https://namespace.invalid" }] }) : "",
      };
    },
  });
  const root = NodePath.join(directory, "remote");
  const request = {
    requestId,
    provider: "namespace",
    creator: "user-test",
    tenantId: "tenant-test",
    providerInstanceId: "codex",
    sourceRevision: null,
    preparationHash: "a".repeat(64),
    image: namespaceMacImage,
    size: "m",
    region: "iad",
    idleTimeoutMinutes: 30,
  };
  const operation = decodeOperation({
    request,
    requestHash: "b".repeat(64),
    revision: 1,
    createdAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:00Z",
    state: {
      kind: "ready",
      allocation: { kind: "direct", resource },
      readiness: {
        environmentId: "test-environment",
        projectDir: `${root}/workspace`,
        sourceRevision: null,
        preparationHash: "a".repeat(64),
        t3Revision: "c".repeat(40),
        artifactSha256: "d".repeat(64),
      },
    },
  });
  return { directory, root, session, commands, tokenFiles, apiCalls, state, operation, request };
}

const decodeServerPid = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);
/** A stand-in for the pinned T3 runtime: it answers the probes the preparation script and the proxy make. */
const fixtureCli = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const args = process.argv.slice(2);
const home = args[args.indexOf('--base-dir') + 1];
const root = path.dirname(path.dirname(home));
if (args[0] === 'auth') {
  process.stdout.write('fixture-broker');
} else if (args[0] === 'project') {
  process.exit(0);
} else {
  fs.appendFileSync(path.join(root, 'started'), 'start\n');
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/t3/environment') {
      response.end(JSON.stringify({ environmentId: fs.readFileSync(path.join(home, 'userdata/environment-id'), 'utf8').trim() }));
    } else if (request.url === '/api/auth/session') {
      response.end(JSON.stringify({ authenticated: request.headers.authorization === 'Bearer fixture-broker', sessionMethod: 'bearer-access-token', scopes: ['access:write'] }));
    } else if (request.url === '/api/auth/pairing-token') {
      response.end(JSON.stringify({ credential: 'grant' }));
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

async function freePort() {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** The supervisor holds this lock until the server it launched exits. */
function serverLockReleased(root: string) {
  return new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "python3",
      [
        "-c",
        "import fcntl,sys\nwith open(sys.argv[1], 'a') as lock: fcntl.flock(lock, fcntl.LOCK_EX)",
        NodePath.join(root, "server.lock"),
      ],
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

describe("Namespace runtime transport", () => {
  it("uploads private input and executes it through captured resource ID without CLI stdin", async () => {
    const f = await fixture();
    const port = namespacePythonPort({
      session: f.session,
      resource,
      root: f.root,
      localDir: f.directory,
    });
    const result = await port.executePython({
      script: "import json,sys; print(json.dumps({'echo':json.load(sys.stdin)['private']}))",
      stdin: encodeJson({ private: "private-payload" }),
    });
    expect(result.exitCode).toBe(0);
    expect(decodeJson(result.stdout)).toEqual({ echo: "private-payload" });
    expect(f.commands.every((args) => args[1] === "owned-box")).toBe(true);
    expect(encodeJson(f.commands)).not.toContain("private-payload");
    expect(await NodeFSP.readdir(f.root)).toEqual([]);
    for (const file of f.tokenFiles) await expect(NodeFSP.stat(file)).rejects.toThrow();
  });

  it("returns remote python stderr when the uploaded script fails", async () => {
    const f = await fixture();
    const port = namespacePythonPort({
      session: f.session,
      resource,
      root: f.root,
      localDir: f.directory,
    });
    const result = await port.executePython({
      script: "import sys; sys.stderr.write('Remote preparation failed: boom\\n'); sys.exit(1)",
      stdin: "{}",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Remote preparation failed: boom");
  });

  it("issues separate grants for the same environment and reconstructs its proxy after manager restart", async () => {
    const f = await fixture();
    let grants = 0;
    const t3 = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/.well-known/t3/environment")
        response.end(encodeJson({ environmentId: "test-environment" }));
      else {
        expect(request.headers.authorization).toBe("Bearer private-broker");
        response.end(encodeJson({ credential: `grant-${++grants}` }));
      }
    });
    await NodeFSP.mkdir(f.root, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(f.root, "broker-token"), "private-broker", {
      mode: 0o600,
    });
    const manifest = decodeManifest({
      input: { requestId, provider: "namespace", providerInstanceId: "codex" },
      request: f.request,
      preparation: {
        requestId,
        root: f.root,
        repository: null,
        artifact: {
          archivePath: "/tmp/unused",
          sha256: "d".repeat(64),
          revision: "c".repeat(40),
          entrypoint: "cli.js",
        },
        runtimeExecutable: "node",
        port: t3.port,
        readinessTimeoutSeconds: 2,
        brokerTtl: "1h",
        files: [],
      },
      localArtifact: {
        path: "/tmp/unused",
        sha256: "d".repeat(64),
        revision: "c".repeat(40),
        entrypoint: "cli.js",
        runtimeExecutable: "node",
      },
      egressAllow: [],
    });
    let opened = 0;
    let publishedStatus = 200;
    let publishedEnvironmentId = "test-environment";
    const published = await listen((request, response) => {
      expect(request.headers["x-nsc-ingress-auth"]).toBe("Bearer private-ingress");
      response.writeHead(publishedStatus, { "content-type": "application/json" });
      response.end(encodeJson({ environmentId: publishedEnvironmentId }));
    });
    const makeRuntime = () => {
      const proxies = new NamespaceProxyManager();
      cleanups.push(() => proxies.close({ proxyId: `provision-${requestId}` }));
      return makeNamespaceProvisionRuntime({
        session: f.session,
        getIngressAuthorization: async () => "Bearer private-ingress",
        stateDir: f.directory,
        proxies: {
          open: async (input) => {
            opened += 1;
            expect(await input.getUpstreamAuthorization()).toMatch(/^Bearer .+/);
            return proxies.open({
              ...input,
              upstreamHttpBaseUrl: published.origin,
              upstreamWsBaseUrl: published.origin.replace("http:", "ws:"),
            });
          },
          restore: (input) =>
            proxies.restore({
              ...input,
              upstreamHttpBaseUrl: published.origin,
              upstreamWsBaseUrl: published.origin.replace("http:", "ws:"),
            }),
          close: (input) => proxies.close(input),
        },
      });
    };
    const first = makeRuntime();
    const attached = await first.attach(f.operation, resource, manifest);
    expect(attached.pairingUrl).toBe(`${attached.namespaceProxy.proxyOrigin}/pair#token=grant-1`);
    expect(attached.namespaceProxy.proxyId).toBe(`provision-${requestId}`);
    expect(await first.attach(f.operation, resource, manifest)).toEqual({
      pairingUrl: `${attached.namespaceProxy.proxyOrigin}/pair#token=grant-2`,
      namespaceProxy: attached.namespaceProxy,
      remoteAccess: { origin: attached.namespaceProxy.proxyOrigin, brokerToken: "private-broker" },
    });
    expect(opened).toBe(1);
    expect((await makeRuntime().attach(f.operation, resource, manifest)).pairingUrl).toMatch(
      /http:\/\/127.0.0.1:\d+\/pair#token=grant-3$/,
    );
    expect(opened).toBe(2);
    publishedStatus = 401;
    await expect(first.attach(f.operation, resource, manifest)).rejects.toThrow(
      "HTTP 401 before T3 identity verification",
    );
    publishedStatus = 200;
    publishedEnvironmentId = "wrong-environment";
    await expect(first.attach(f.operation, resource, manifest)).rejects.toThrow(
      "different T3 environment",
    );
    publishedEnvironmentId = "test-environment";
    expect((await first.attach(f.operation, resource, manifest)).pairingUrl).toBe(
      `${attached.namespaceProxy.proxyOrigin}/pair#token=grant-6`,
    );
    expect(await NodeFSP.readFile(NodePath.join(f.root, "broker-token"), "utf8")).toBe(
      "private-broker",
    );
  });

  it("extends and reads back the captured instance deadline using the same account", async () => {
    const f = await fixture();
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    const before = DateTime.toEpochMillis(DateTime.nowUnsafe());
    await runtime.touch(f.operation, resource);
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(f.state.deadline))).toBeGreaterThanOrEqual(
      before + 21_600_000,
    );
    expect(
      f.apiCalls.filter(({ method }) => method === "ExtendInstance").map(({ body }) => body),
    ).toEqual([{ instanceId: "owned-instance", ensureMinimum: "21600s" }]);
    expect(f.apiCalls.filter(({ method }) => method === "DescribeInstance")).toHaveLength(2);
    expect(f.apiCalls.some(({ method }) => method === "Update")).toBe(false);
    f.state.creator = "another-owner";
    await expect(runtime.retainImportedLease(resource)).rejects.toThrow("configured account");
    expect(f.apiCalls.filter(({ method }) => method === "ExtendInstance")).toHaveLength(1);
  });

  it("sets the immutable cap even when the existing provider deadline is later", async () => {
    const f = await fixture();
    const deadline = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3_600_000),
    );
    f.state.deadline = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 18_000_000),
    );
    const operation = decodeOperation({
      ...f.operation,
      request: { ...f.request, retentionDeadline: deadline },
    });
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await runtime.touch(operation, resource);
    await runtime.touch(operation, resource);
    expect(
      f.apiCalls.filter(({ method }) => method === "ExtendInstance").map(({ body }) => body),
    ).toEqual([
      { instanceId: "owned-instance", newDeadline: deadline },
      { instanceId: "owned-instance", newDeadline: deadline },
    ]);
    expect(f.state.deadline).toBe(deadline);
  });

  it.each([-1000, 1000])(
    "rejects an acknowledgment offset from the cap by %i milliseconds",
    async (offset) => {
      const f = await fixture();
      f.state.capOffset = offset;
      const deadline = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3_600_000),
      );
      const operation = decodeOperation({
        ...f.operation,
        request: { ...f.request, retentionDeadline: deadline },
      });
      const runtime = makeNamespaceProvisionRuntime({
        session: f.session,
        getIngressAuthorization: async () => "Bearer private-ingress",
        stateDir: f.directory,
      });
      await expect(runtime.touch(operation, resource)).rejects.toThrow(ProvisionRetentionError);
    },
  );

  it("rejects cap acknowledgment when provider readback still exceeds the cap", async () => {
    const f = await fixture();
    f.state.staleReadback = true;
    f.state.deadline = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 18_000_000),
    );
    const deadline = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3_600_000),
    );
    const operation = decodeOperation({
      ...f.operation,
      request: { ...f.request, retentionDeadline: deadline },
    });
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await expect(runtime.touch(operation, resource)).rejects.toThrow(ProvisionRetentionError);
  });

  it("does not renew a request whose immutable deadline has elapsed", async () => {
    const f = await fixture();
    const operation = decodeOperation({
      ...f.operation,
      request: { ...f.request, retentionDeadline: "2000-01-01T00:00:00.000Z" },
    });
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await expect(runtime.touch(operation, resource)).rejects.toThrow(ProvisionRetentionError);
    expect(f.apiCalls.some(({ method }) => method === "ExtendInstance")).toBe(false);
  });

  it("accepts a heartbeat extension clamped to the provider's lifetime cap", async () => {
    const f = await fixture();
    const created = DateTime.toEpochMillis(DateTime.nowUnsafe()) - 3_600_000;
    f.state.deadline = DateTime.formatIso(DateTime.makeUnsafe(created + 14_400_000));
    f.state.lifetimeCap = created + 18_000_000;
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await runtime.touch(f.operation, resource);
    expect(f.state.deadline).toBe(DateTime.formatIso(DateTime.makeUnsafe(created + 18_000_000)));
  });

  it("rejects a provider acknowledgment that shortens the captured deadline", async () => {
    const f = await fixture();
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    f.state.deadline = DateTime.formatIso(DateTime.makeUnsafe(now + 18_000_000));
    f.state.lifetimeCap = now + 14_400_000;
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await expect(runtime.touch(f.operation, resource)).rejects.toThrow("did not extend");
  });

  it("rejects acknowledged extension when the actual deadline remains stale", async () => {
    const f = await fixture();
    f.state.staleReadback = true;
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await expect(runtime.touch(f.operation, resource)).rejects.toThrow("readback");
  });

  it.each(["destroyed", "changed instance"])("does not extend a %s instance", async (kind) => {
    const f = await fixture();
    if (kind === "destroyed") f.state.destroyed = true;
    else f.state.describedInstanceId = "different-instance";
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await expect(runtime.touch(f.operation, resource)).rejects.toThrow("active deadline");
    expect(f.apiCalls.some(({ method }) => method === "ExtendInstance")).toBe(false);
  });

  it("bounds a real stuck CLI process and removes its private credential staging", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "namespace-timeout-"));
    cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    const pidFile = NodePath.join(directory, "child.pid");
    const session = await makeNamespaceAccountSession({
      stateDir: directory,
      token,
      cli: process.execPath,
      commandTimeoutMs: 500,
    });
    await expect(
      session.run([
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
        pidFile,
      ]),
    ).rejects.toThrow("timed out");
    const pid = Number(await NodeFSP.readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await NodeFSP.readdir(directory)).toEqual(["child.pid"]);
  });

  it("resumes a shut-down Devbox from its retained volume at the origin its client saved", async () => {
    const f = await fixture();
    const volume = NodePath.join(f.directory, "volume");
    const root = NodePath.join(volume, "t3-provision", requestId);
    const bundle = NodePath.join(f.directory, "bundle");
    await NodeFSP.mkdir(bundle);
    await NodeFSP.writeFile(NodePath.join(bundle, "cli.mjs"), fixtureCli);
    const archive = NodePath.join(f.directory, "runtime.tar");
    NodeChildProcess.execFileSync("tar", ["-cf", archive, "-C", bundle, "cli.mjs"]);
    const sha256 = provisionDigest(await NodeFSP.readFile(archive));
    const port = await freePort();
    cleanups.push(async () => {
      const pid = await NodeFSP.readFile(NodePath.join(root, "server.json"), "utf8")
        .then((json) => decodeServerPid(json).pid)
        .catch(() => undefined);
      if (pid !== undefined)
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* The server already stopped. */
        }
    });
    const deadline = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3_600_000),
    );
    const request = { ...f.request, retentionDeadline: deadline };
    const manifest = decodeManifest({
      input: {
        requestId,
        provider: "namespace",
        providerInstanceId: "codex",
        retentionDeadline: deadline,
      },
      request,
      preparation: {
        requestId,
        root,
        repository: null,
        artifact: {
          archivePath: `${volume}/t3-runtime-${sha256}.tar`,
          sha256,
          revision: "c".repeat(40),
          entrypoint: "cli.mjs",
        },
        runtimeExecutable: process.execPath,
        port,
        readinessTimeoutSeconds: 30,
        brokerTtl: "1h",
        files: [],
      },
      localArtifact: {
        path: archive,
        sha256,
        revision: "c".repeat(40),
        entrypoint: "cli.mjs",
        runtimeExecutable: process.execPath,
      },
      egressAllow: [],
    });
    const upstream = `http://127.0.0.1:${port}`;
    const proxyId = `provision-${requestId}`;
    const makeRuntime = (proxies: NamespaceProxyManager) => {
      cleanups.push(() => proxies.close({ proxyId }));
      const toUpstream = <T extends object>(input: T) => ({
        ...input,
        upstreamHttpBaseUrl: upstream,
        upstreamWsBaseUrl: upstream.replace("http:", "ws:"),
      });
      return makeNamespaceProvisionRuntime({
        session: f.session,
        getIngressAuthorization: async () => "Bearer private-ingress",
        stateDir: f.directory,
        proxies: {
          open: (input) => proxies.open(toUpstream(input)),
          restore: (input) => proxies.restore(toUpstream(input)),
          close: (input) => proxies.close(input),
        },
      });
    };
    const environmentAt = async (origin: string) =>
      decodeJson(await (await fetch(`${origin}/.well-known/t3/environment`)).text());
    const started = () => NodeFSP.readFile(NodePath.join(root, "started"), "utf8");
    const archiveUploads = () =>
      f.commands.filter((args) => args[0] === "upload" && args[3]?.endsWith("/runtime.tar"));
    const extensions = () =>
      f.apiCalls.filter(({ method }) => method === "ExtendInstance").map(({ body }) => body);

    const firstProxies = new NamespaceProxyManager();
    const first = makeRuntime(firstProxies);
    const ready = await first.prepare(
      decodeOperation({ ...f.operation, request }),
      resource,
      manifest,
    );
    const operation = decodeOperation({
      ...f.operation,
      request,
      state: {
        kind: "ready",
        allocation: { kind: "direct", resource },
        readiness: {
          environmentId: ready.environmentId,
          projectDir: `${root}/workspace`,
          sourceRevision: null,
          preparationHash: "a".repeat(64),
          t3Revision: "c".repeat(40),
          artifactSha256: sha256,
        },
      },
    });
    const attached = await first.attach(operation, resource, manifest);
    const origin = attached.namespaceProxy.proxyOrigin;
    expect(attached.pairingUrl).toBe(`${origin}/pair#token=grant`);
    expect(await environmentAt(origin)).toEqual({ environmentId: ready.environmentId });
    expect(archiveUploads()).toHaveLength(1);

    // Pause: the Mac shuts down, taking its instance and server with it. The
    // volume, and everything T3 prepared on it, stays.
    expect(await (await fetch(`${upstream}/stop`)).text()).toBe("stopped");
    await serverLockReleased(root);
    f.state.instanceId = "";

    expect(await first.resume(operation, resource, manifest, attached.namespaceProxy)).toEqual(
      attached.namespaceProxy,
    );
    expect(f.commands).toContainEqual(["exec", "owned-box", "--", "true"]);
    expect(f.state.instanceId).toBe("woken-instance");
    expect(await started()).toBe("start\nstart\n");
    expect(archiveUploads()).toHaveLength(1);
    expect(extensions()).toEqual([
      { instanceId: "owned-instance", newDeadline: deadline },
      { instanceId: "owned-instance", newDeadline: deadline },
      { instanceId: "woken-instance", newDeadline: deadline },
      { instanceId: "woken-instance", newDeadline: deadline },
    ]);
    expect(await environmentAt(origin)).toEqual({ environmentId: ready.environmentId });

    // The manager restarts: its loopback proxy is gone, the Mac keeps running,
    // and the client still holds the origin it saved.
    await firstProxies.close({ proxyId });
    await expect(environmentAt(origin)).rejects.toThrow();
    const second = makeRuntime(new NamespaceProxyManager());
    expect(await second.resume(operation, resource, manifest, attached.namespaceProxy)).toEqual(
      attached.namespaceProxy,
    );
    expect(await environmentAt(origin)).toEqual({ environmentId: ready.environmentId });
    expect(await started()).toBe("start\nstart\n");
    expect(archiveUploads()).toHaveLength(1);
  });

  it("accepts provider removal of the devbox during shutdown", async () => {
    const f = await fixture();
    f.state.expireOnShutdown = true;
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await runtime.dispose(f.operation, resource);
    expect(f.commands).toEqual([["shutdown", "owned-box", "--force"]]);
  });

  it("disposes a stopped owned resource and treats an already expired resource as complete", async () => {
    const f = await fixture();
    f.state.instanceId = "";
    const runtime = makeNamespaceProvisionRuntime({
      session: f.session,
      getIngressAuthorization: async () => "Bearer private-ingress",
      stateDir: f.directory,
    });
    await runtime.dispose(f.operation, resource);
    await runtime.dispose(f.operation, resource);
    expect(f.commands).toEqual([["expire", "owned-box", "--force"]]);
  });
});
