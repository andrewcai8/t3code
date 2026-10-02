// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this test exercises real local HTTP and private state files.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeWS } from "@effect/platform-node-shared/NodeSocket";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { AccessMode } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { EnvironmentControl, layer } from "./EnvironmentControl.ts";
import { InstanceId } from "./namespaceInstances.ts";
import { namespaceMacImage } from "./namespaceAllocation.ts";
import { makeChatStore } from "./namespaceChatStore.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";
import { ProvisionPreparationManifest, provisionDigest } from "./ProvisionPreparation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);
const sessionFactory = vi.hoisted(() => vi.fn());
const exposeInstance = vi.hoisted(() => vi.fn());

vi.mock("./NamespaceProvisionRuntime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./NamespaceProvisionRuntime.ts")>()),
  makeNamespaceAccountSession: sessionFactory,
}));
vi.mock("./namespaceInstances.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./namespaceInstances.ts")>();
  return {
    ...original,
    makeNamespaceInstances: () => ({
      list: async () => [],
      expose: exposeInstance,
    }),
  };
});

const requestId = "7314a443-30af-4c88-b3ca-9b70940eb563";
const MAC = InstanceId.make("mac-1");
const devbox = {
  provider: "namespace" as const,
  devboxId: "owned-box",
  devboxName: `t3-${requestId}`,
  instanceId: "owned-instance",
  region: "iad",
  workspaceDir: "/Users/runner/workspaces",
};
const instance = { provider: "namespace" as const, engine: "instance" as const, chatId: requestId };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address !== "string" ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });

// A box whose agent is mid-turn, as its shell reads.
const workingShell = {
  threads: [{ archivedAt: null, session: { status: "running" }, hasPendingApprovals: false }],
};

type Engine = "devbox" | "instance";

/**
 * Runs `body` against a manager that just started, holding an active `engine` lease the previous
 * process recorded at a loopback proxy origin no process listens on any more.
 */
const afterRestart = <E>(
  engine: Engine,
  body: (input: {
    readonly manager: EnvironmentControl["Service"];
    readonly recorded: { readonly proxyId: string; readonly proxyOrigin: string };
    readonly upgrades: ReadonlyArray<{
      url: string | undefined;
      authorization: string | string[] | undefined;
    }>;
  }) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "namespace-reconnect-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const upstream = NodeHttp.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        encodeJson(
          request.url?.endsWith("/api/orchestration/shell")
            ? workingShell
            : { environmentId: "namespace-environment", upstream: request.url },
        ),
      );
    });
    // An echo, to prove an upgrade crosses the proxy both ways with the ingress bearer.
    const upgrades: Array<{
      url: string | undefined;
      authorization: string | string[] | undefined;
    }> = [];
    const echoes = new NodeWS.WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      upgrades.push({ url: request.url, authorization: request.headers["x-nsc-ingress-auth"] });
      echoes.handleUpgrade(request, socket, head, (client) =>
        client.on("message", (message) => client.send(message.toString())),
      );
    });
    yield* Effect.acquireRelease(
      Effect.promise(
        () => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
      ),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              // An upgraded socket is no longer the server's to close.
              for (const client of echoes.clients) client.terminate();
              upstream.closeAllConnections();
              upstream.close(() => resolve());
            }),
        ),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");
    const upstreamOrigin = `http://127.0.0.1:${address.port}`;
    const originalFetch = globalThis.fetch;
    const managers = new Set<NamespaceProxyManager>();
    const originalRestore = NamespaceProxyManager.prototype.restore;
    vi.spyOn(NamespaceProxyManager.prototype, "restore").mockImplementation(function (
      this: NamespaceProxyManager,
      input,
    ) {
      managers.add(this);
      return originalRestore.call(this, input);
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const manager of managers) await manager.close({ proxyId: `provision-${requestId}` });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }),
    );
    // Namespace exposes HTTPS; route only that synthetic provider host to our real HTTP upstream.
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return originalFetch(
        url.hostname.endsWith(".namespace.invalid")
          ? `${upstreamOrigin}/${url.hostname.split(".")[0]}${url.pathname}`
          : input,
        init,
      );
    });
    exposeInstance.mockImplementation(async () => upstreamOrigin);
    const configPath = NodePath.join(directory, "environment-control.json");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        configPath,
        encodeJson({
          namespaceToken: "token",
          e2bApiKey: "unused-test-key",
          broker: {
            sandboxId: "unused",
            metadata: { owner: "fixture" },
            url: "https://unused.invalid",
            ingressKey: "unused",
          },
          targets: [],
        }),
      ),
    );
    vi.stubEnv("T3CODE_ENVIRONMENT_CONTROL_CONFIG", configPath);
    sessionFactory.mockImplementation(async () => ({
      identity: { creator: "user-test", tenantId: "tenant-test" },
      issueToken: async () => "token",
      artifacts: {},
      client: {
        fetch: async () => ({
          devbox: {
            id: devbox.devboxId,
            name: devbox.devboxName,
            creator: "user-test",
            site: "iad",
            workspaceDir: devbox.workspaceDir,
            repository: "",
            imageRef: "",
            accessMode: AccessMode.USER_PRIVATE,
            instanceShape: {
              os: "macos",
              machineArch: "arm64",
              virtualCpu: 6,
              memoryMegabytes: 14336,
              selectors: [
                { name: "macos.version", value: "26.x" },
                { name: "macos.purpose", value: "githubrunner" },
                { name: "image.with", value: "xcode-latest" },
              ],
            },
          },
          instanceId: devbox.instanceId,
        }),
      },
      run: async (args: ReadonlyArray<string>) => ({
        exitCode: 0,
        stdout:
          args[0] === "url"
            ? encodeJson({ urls: [{ url: "https://devbox.namespace.invalid" }] })
            : "present",
      }),
    }));
    const artifact = {
      archivePath: "/guest/runtime.tar",
      sha256: provisionDigest("fixture"),
      revision: "c".repeat(40),
      entrypoint: "dist/bin.mjs",
    };
    const preparation = {
      requestId,
      root: "/guest/operation",
      repository: null,
      artifact,
      runtimeExecutable: "node",
      port: 3773,
      readinessTimeoutSeconds: 180,
      brokerTtl: "7d",
      files: [],
    };
    const preparationHash = provisionDigest(stableStringify({ preparation, egressAllow: [] }));
    const manifest = decodeManifest({
      input: { requestId, provider: "namespace", providerInstanceId: "codex" },
      request: {
        requestId,
        provider: "namespace",
        creator: "user-test",
        tenantId: "tenant-test",
        providerInstanceId: "codex",
        sourceRevision: null,
        preparationHash,
        image: namespaceMacImage,
        size: "m",
        region: "iad",
        idleTimeoutMinutes: 30,
        ...(engine === "instance" ? { engine: "instance" } : {}),
      },
      preparation,
      localArtifact: { path: "/local/runtime.tar", ...artifact, runtimeExecutable: "node" },
      egressAllow: [],
    });
    const readiness = {
      environmentId: EnvironmentId.make("namespace-environment"),
      projectDir: "/guest/operation/workspace",
      sourceRevision: null,
      preparationHash,
      t3Revision: artifact.revision,
      artifactSha256: artifact.sha256,
    };
    // What the previous process recorded: an active lease served at a loopback port that no
    // process listens on any more.
    const recorded = {
      proxyId: `provision-${requestId}`,
      proxyOrigin: `http://127.0.0.1:${yield* Effect.promise(freePort)}`,
    };
    yield* Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProvisionOperationStore;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(stateDir, "provisioning"), {
          recursive: true,
          mode: 0o700,
        });
        await NodeFSP.writeFile(
          NodePath.join(stateDir, "provisioning", `${requestId}.json`),
          encodeJson(manifest),
          { mode: 0o600 },
        );
        await makeChatStore(stateDir).update(requestId, () => ({
          ok: true,
          record: {
            kind: "live",
            snapshot: null,
            mac: {
              incarnation: { instanceId: MAC, site: "iad4", createdAt: 0, deadline: 1 },
              cache: "ready",
            },
          },
          garbage: [],
        }));
      });
      const operation = yield* store.accept(manifest.request);
      const resource = engine === "instance" ? instance : devbox;
      yield* store.advance(operation, {
        kind: "ready",
        allocation: { kind: "direct", resource },
        readiness,
      });
      const registry = createProvisionedLeaseRegistry(sql);
      yield* Effect.promise(() =>
        registry.register({
          leaseId: requestId,
          sandboxId: engine === "instance" ? requestId : devbox.devboxId,
          provider: "namespace",
          providerInstanceId: "codex",
          namespaceProxy: recorded,
          ...(engine === "instance" ? {} : { namespaceResource: devbox }),
          owner: { environmentId: readiness.environmentId, threadId: "thread" },
        }),
      );
      const active = yield* Effect.promise(() =>
        registry.markActive({
          leaseId: requestId,
          remoteAccess: { origin: recorded.proxyOrigin, brokerToken: "broker" },
        }),
      );
      expect(active?.state).toBe("active");

      yield* body({ manager: yield* EnvironmentControl, recorded, upgrades });
    }).pipe(
      Effect.provide(
        Layer.merge(layer, ProvisionOperationStore.layer).pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(makeProviderRegistryLayer()),
          Layer.provideMerge(ServerConfig.layerTest(directory, directory)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped);

it.effect.each(["devbox", "instance"] as const)(
  "serves an active %s lease's recorded origin again after the manager restarted",
  (engine) =>
    afterRestart(engine, ({ manager, recorded, upgrades }) =>
      Effect.gen(function* () {
        const origin = yield* manager.namespaceProxyOrigin(requestId);
        expect(origin, "the gateway keeps the origin its clients saved").toBe(recorded.proxyOrigin);
        const reached = yield* Effect.promise(() => probe(`${origin}/probe`));
        expect(reached).toEqual({
          environmentId: "namespace-environment",
          upstream: engine === "instance" ? "/probe" : "/devbox/probe",
        });
        if (engine === "instance") {
          expect(exposeInstance).toHaveBeenCalledWith(MAC, 3773);
          const echoed = yield* Effect.promise(() =>
            echo(`${origin!.replace(/^http/, "ws")}/ws?wsTicket=ticket`),
          );
          expect([echoed, upgrades]).toEqual([
            "ping",
            [{ url: "/ws?wsTicket=ticket", authorization: "Bearer token" }],
          ]);
        }
      }),
    ),
);

// Pause, the reaper and a Mac's deadline upkeep judge a box by the same read. None may take a
// working agent for idle only because no client has asked for its origin since the restart.
it.effect.each(["devbox", "instance"] as const)(
  "reads a working agent on an active %s lease after the manager restarted, before any client asks for it",
  (engine) =>
    afterRestart(engine, ({ manager }) =>
      Effect.gen(function* () {
        const paused = yield* manager.pause({
          sandboxId: engine === "instance" ? requestId : devbox.devboxId,
        });
        expect(paused).toEqual({
          kind: "refused",
          reason: "unknown",
          message: "Another chat on this machine is still working.",
        });
      }),
    ),
);

const probe = async (url: string) => (await fetch(url)).json().catch(() => null);

const echo = (url: string) =>
  new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => socket.send("ping"), { once: true });
    socket.addEventListener(
      "message",
      (event) => {
        resolve(event.data);
        socket.close();
      },
      { once: true },
    );
    socket.addEventListener("error", () => reject(new Error(`websocket to ${url} failed`)), {
      once: true,
    });
  });
