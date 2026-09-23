// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this test exercises real local HTTP and private config files.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
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
import { makeNamespaceAccountSession } from "./NamespaceProvisionRuntime.ts";
import { NamespaceProxyManager, type NamespaceProxyOpenInput } from "./namespaceProxy.ts";
import { namespaceMacImage } from "./namespaceAllocation.ts";
import { prepareRemoteHost } from "./remotePreparation.ts";
import { ProvisionPreparationManifest, provisionDigest } from "./ProvisionPreparation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);
const sessionFactory = vi.hoisted(() => vi.fn());

vi.mock("./NamespaceProvisionRuntime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./NamespaceProvisionRuntime.ts")>()),
  makeNamespaceAccountSession: sessionFactory,
}));
vi.mock("./remotePreparation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remotePreparation.ts")>()),
  prepareRemoteHost: vi.fn(),
}));

it.effect(
  "resumes a provisioned Namespace endpoint after config reload without replacing its listener",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "namespace-reload-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const upstream = NodeHttp.createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          encodeJson({
            environmentId: "namespace-environment",
            upstream: request.url,
            authorization: request.headers["x-nsc-ingress-auth"],
          }),
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
      const originalOpen = NamespaceProxyManager.prototype.open;
      vi.spyOn(NamespaceProxyManager.prototype, "open").mockImplementation(function (
        this: NamespaceProxyManager,
        input: NamespaceProxyOpenInput,
      ) {
        managers.add(this);
        return originalOpen.call(this, input);
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
      const requestId = "7314a443-30af-4c88-b3ca-9b70940eb563";
      const resource = {
        provider: "namespace" as const,
        devboxId: "owned-box",
        devboxName: `t3-${requestId}`,
        instanceId: "owned-instance",
        region: "iad",
        workspaceDir: "/Users/runner/workspaces",
      };
      const configPath = NodePath.join(directory, "environment-control.json");
      const config = (token: string) =>
        encodeJson({
          namespaceToken: token,
          e2bApiKey: "unused-test-key",
          broker: {
            sandboxId: "unused",
            metadata: { owner: "fixture" },
            url: "https://unused.invalid",
            ingressKey: "unused",
          },
          targets: [],
        });
      yield* Effect.promise(() => NodeFSP.writeFile(configPath, config("first")));
      vi.stubEnv("T3CODE_ENVIRONMENT_CONTROL_CONFIG", configPath);
      sessionFactory.mockImplementation(async ({ token }: { token: string }) => ({
        identity: { creator: "user-test", tenantId: "tenant-test" },
        issueToken: async () => token,
        client: {
          fetch: async () => ({
            devbox: {
              id: resource.devboxId,
              name: resource.devboxName,
              creator: "user-test",
              site: "iad",
              workspaceDir: resource.workspaceDir,
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
                  { name: "image.with", value: "xcode-26.4.x" },
                  { name: "image.with", value: "xcode-beta" },
                ],
              },
            },
            instanceId: resource.instanceId,
          }),
        },
        run: async (args: ReadonlyArray<string>) => ({
          exitCode: 0,
          stdout:
            args[0] === "url"
              ? encodeJson({ urls: [{ url: `https://${token}.namespace.invalid` }] })
              : "present",
        }),
      }));
      const artifactPath = NodePath.join(directory, "runtime.tar");
      yield* Effect.promise(() => NodeFSP.writeFile(artifactPath, "fixture"));
      const artifact = {
        archivePath: artifactPath,
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
        },
        preparation,
        localArtifact: { path: artifactPath, ...artifact, runtimeExecutable: "node" },
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
      vi.mocked(prepareRemoteHost).mockResolvedValue({
        ...readiness,
        headRevision: artifact.revision,
        runtimeVersion: "v24.0.0",
        serverPid: 123,
        brokerCredentialPath: "/guest/operation/broker",
      });
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
        });
        const operation = yield* store.accept(manifest.request);
        yield* store.advance(operation, {
          kind: "ready",
          allocation: { kind: "direct", resource },
          readiness,
        });
        const registry = createProvisionedLeaseRegistry(sql);
        yield* Effect.promise(async () => {
          await registry.register({
            leaseId: requestId,
            sandboxId: resource.devboxId,
            provider: "namespace",
            providerInstanceId: "codex",
            namespaceResource: resource,
          });
          await registry.claim({
            leaseId: requestId,
            owner: { environmentId: readiness.environmentId, threadId: "thread" },
          });
        });
        const manager = yield* EnvironmentControl;
        expect(
          yield* manager.resume({ environmentId: EnvironmentId.make("unprovisioned") }),
        ).toEqual({
          kind: "refused",
          reason: "not-provisioned",
          message: "This machine has no workspace for that environment.",
        });
        expect(prepareRemoteHost).not.toHaveBeenCalled();
        const input = { environmentId: readiness.environmentId };
        expect(yield* manager.resume(input)).toEqual({ kind: "resumed" });
        const before = yield* Effect.promise(() => registry.findById(requestId));
        const origin = before?.namespaceProxy?.proxyOrigin;
        expect(origin).toBeDefined();
        expect(yield* Effect.promise(() => awaitProxy(origin!))).toEqual({
          environmentId: "namespace-environment",
          upstream: "/first/probe",
          authorization: "Bearer first",
        });
        yield* Effect.promise(async () => {
          const prior = await NodeFSP.stat(configPath);
          await NodeFSP.writeFile(configPath, config("second"));
          await NodeFSP.utimes(configPath, prior.atime, prior.mtimeMs / 1000 + 2);
        });
        expect(yield* manager.resume(input)).toEqual({ kind: "resumed" });
        const after = yield* Effect.promise(() => registry.findById(requestId));
        expect(after?.namespaceProxy).toEqual(before?.namespaceProxy);
        expect(yield* Effect.promise(() => awaitProxy(origin!))).toEqual({
          environmentId: "namespace-environment",
          upstream: "/second/probe",
          authorization: "Bearer second",
        });
        expect(makeNamespaceAccountSession).toHaveBeenCalledTimes(2);
        expect(prepareRemoteHost).toHaveBeenCalledTimes(2);
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

const awaitProxy = async (origin: string) => (await fetch(`${origin}/probe`)).json();
