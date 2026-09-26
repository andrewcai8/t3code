// @effect-diagnostics nodeBuiltinImport:off - this test writes private manager config and manifest files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { EnvironmentControl, layer } from "./EnvironmentControl.ts";
import { ProvisionPreparationManifest, provisionDigest } from "./ProvisionPreparation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), wake: vi.fn() }));

vi.mock("./E2bProvisionRuntime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./E2bProvisionRuntime.ts")>()),
  makeE2bProvisionRuntime: () => ({ prepare: mocks.prepare }),
}));
vi.mock("./driver.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./driver.ts")>();
  return {
    ...actual,
    createCloudDriver: (...args: Parameters<typeof actual.createCloudDriver>) => ({
      ...actual.createCloudDriver(...args),
      resume: mocks.wake,
    }),
  };
});

it.effect("reprepares a woken E2B box and keeps its lease active even when that fails", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "e2b-resume-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const requestId = "0b0f7f61-8a52-4f6c-9d0b-6f3a2a8d3c11";
    const configPath = NodePath.join(directory, "environment-control.json");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        configPath,
        encodeJson({
          e2bApiKey: "test-key",
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
      root: "/home/user/operation",
      repository: { url: "https://github.com/owner/repo", revision: "a".repeat(40) },
      artifact,
      runtimeExecutable: "node",
      port: 3773,
      readinessTimeoutSeconds: 180,
      brokerTtl: "7d",
      files: [],
    };
    const preparationHash = provisionDigest(stableStringify({ preparation, egressAllow: [] }));
    const manifest = decodeManifest({
      input: { requestId, provider: "e2b", providerInstanceId: "codex", repository: "owner/repo" },
      request: {
        requestId,
        provider: "e2b",
        templateId: "template",
        strategy: "direct",
        providerInstanceId: "codex",
        repository: "owner/repo",
        sourceRevision: "a".repeat(40),
        preparationHash,
      },
      preparation,
      localArtifact: { path: artifactPath, ...artifact, runtimeExecutable: "node" },
      egressAllow: [],
    });
    const readiness = {
      environmentId: EnvironmentId.make("e2b-environment"),
      projectDir: "/home/user/operation/workspace",
      sourceRevision: "a".repeat(40),
      preparationHash,
      t3Revision: artifact.revision,
      artifactSha256: artifact.sha256,
    };
    mocks.wake.mockResolvedValue({});
    mocks.prepare.mockRejectedValue(new Error("server did not start"));
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
        allocation: { kind: "direct", resource: { provider: "e2b", sandboxId: "sandbox-1" } },
        readiness,
      });
      const registry = createProvisionedLeaseRegistry(sql);
      yield* Effect.promise(async () => {
        await registry.register({
          leaseId: requestId,
          sandboxId: "sandbox-1",
          provider: "e2b",
          providerInstanceId: "codex",
        });
        await registry.claim({
          leaseId: requestId,
          owner: { environmentId: readiness.environmentId, threadId: "thread" },
        });
        await registry.markPaused(requestId);
      });
      const manager = yield* EnvironmentControl;
      const input = { environmentId: readiness.environmentId };

      expect(yield* manager.resume(input)).toEqual({ kind: "resumed" });
      expect((yield* Effect.promise(() => registry.findById(requestId)))?.state).toBe("active");
      const [prepared, sandboxId, preparedManifest] = mocks.prepare.mock.calls[0]!;
      expect([prepared.request.requestId, sandboxId, preparedManifest.input]).toEqual([
        requestId,
        "sandbox-1",
        manifest.input,
      ]);
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
