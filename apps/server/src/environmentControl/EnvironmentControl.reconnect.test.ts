// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this test exercises real local HTTP and private state files.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
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

it.effect.each(["devbox", "instance"] as const)(
  "serves an active %s lease's recorded origin again after the manager restarted",
  (engine) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "namespace-reconnect-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const upstream = NodeHttp.createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(encodeJson({ environmentId: "namespace-environment", upstream: request.url }));
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
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
          for (const manager of managers)
            await manager.close({ proxyId: `provision-${requestId}` });
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
      exposeInstance.mockResolvedValue("https://mac.namespace.invalid");
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
                cache: "reader",
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
        expect((yield* Effect.promise(() => registry.findById(requestId)))?.state).toBe("active");

        const manager = yield* EnvironmentControl;
        const origin = yield* manager.namespaceProxyOrigin(requestId);
        expect(origin, "the gateway keeps the origin its clients saved").toBe(recorded.proxyOrigin);
        const reached = yield* Effect.promise(() => probe(`${origin}/probe`));
        expect(reached).toEqual({
          environmentId: "namespace-environment",
          upstream: `/${engine === "instance" ? "mac" : "devbox"}/probe`,
        });
        if (engine === "instance") expect(exposeInstance).toHaveBeenCalledWith(MAC, 3773);
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
    }).pipe(Effect.scoped),
);

const probe = async (url: string) => (await fetch(url)).json().catch(() => null);
