// @effect-diagnostics nodeBuiltinImport:off - this test serves a box's shell over local HTTP and writes private manager config.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { EnvironmentControl, layer } from "./EnvironmentControl.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "a box list that asks for chats reads the box the host holds no chat for",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "box-chats-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
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

      const reads: string[] = [];
      // The manager's startup usage sweep reads the box first. It finds no chat yet, so the host
      // keeps none and the box stays unread for the list.
      const swept = yield* Deferred.make<void>();
      const listed = yield* Deferred.make<void>();
      const box = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = NodeHttp.createServer((request, response) => {
            // The sweep also pulls the idle box's usage, which this test does not follow.
            if (request.url !== "/api/orchestration/shell") {
              response.writeHead(404).end();
              return;
            }
            reads.push(`${request.url} ${request.headers.authorization}`);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                boxShell(
                  reads.length === 1 ? [] : [boxThread("thread-owner", "project-app", "New chat")],
                ),
              ),
            );
            Deferred.doneUnsafe(reads.length === 1 ? swept : listed, Effect.void);
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          return server;
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      );
      const origin = `http://127.0.0.1:${(box.address() as NodeNet.AddressInfo).port}`;

      const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
      yield* Effect.promise(async () => {
        await registry.register({
          leaseId: "lease",
          sandboxId: "sandbox",
          provider: "e2b",
          providerInstanceId: "codex",
          owner: { environmentId: "box", threadId: "thread-owner" },
        });
        await registry.markActive({
          leaseId: "lease",
          remoteAccess: { origin, brokerToken: "broker" },
        });
      });
      yield* Effect.gen(function* () {
        yield* Deferred.await(swept);
        const manager = yield* EnvironmentControl;
        yield* manager.listProvisioned();
        yield* manager.listProvisioned(undefined, undefined, []);
        yield* Deferred.await(listed);
        expect(reads).toEqual([
          "/api/orchestration/shell Bearer broker",
          "/api/orchestration/shell Bearer broker",
        ]);
      }).pipe(
        Effect.provide(
          Layer.merge(layer, ProvisionOperationStore.layer).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(makeProviderRegistryLayer()),
            Layer.provideMerge(ServerConfig.layerTest(directory, directory)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  // A list that never reads the box fails here instead of hanging.
  10_000,
);
