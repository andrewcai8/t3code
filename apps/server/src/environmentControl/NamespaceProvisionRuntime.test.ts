import { ProvisionRetentionError } from "./retention.ts";
// @effect-diagnostics nodeBuiltinImport:off - these tests execute the uploaded Python files and SDK HTTP requests locally.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
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
import { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";

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
    shortExtension: false,
    capOffset: 0,
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
              : DateTime.toEpochMillis(DateTime.nowUnsafe()) +
                (state.shortExtension ? 60_000 : 21_600_000)) + state.capOffset,
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
        const separator = args.indexOf("--");
        const executable = args[separator + 1];
        if (!executable) throw new Error("Missing remote executable");
        return await new Promise((resolve) => {
          NodeChildProcess.execFile(
            executable,
            args.slice(separator + 2),
            { encoding: "utf8" },
            (error, stdout) => resolve({ exitCode: error ? 1 : 0, stdout }),
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
          close: (input) => proxies.close(input),
        },
      });
    };
    const first = makeRuntime();
    expect(await first.attach(f.operation, resource, manifest)).toMatch(
      /http:\/\/127.0.0.1:\d+\/pair#token=grant-1$/,
    );
    expect(await first.attach(f.operation, resource, manifest)).toMatch(
      /http:\/\/127.0.0.1:\d+\/pair#token=grant-2$/,
    );
    expect(opened).toBe(1);
    expect(await makeRuntime().attach(f.operation, resource, manifest)).toMatch(
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
    expect(await first.attach(f.operation, resource, manifest)).toMatch(/\/pair#token=grant-6$/);
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

  it("rejects a provider acknowledgment below the requested lifetime", async () => {
    const f = await fixture();
    f.state.shortExtension = true;
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

  it("accepts provider auto-removal of an ephemeral devbox during shutdown", async () => {
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
