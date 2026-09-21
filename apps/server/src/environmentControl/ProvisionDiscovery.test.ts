// @effect-diagnostics globalDate:off - fixed historical timestamps exercise expiry.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DurableProvisionRequest, EnvironmentId, ProvisionRequestId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

const expiredAt = new Date("1960-01-01T00:00:00.000Z");
const decodeRequest = Schema.decodeUnknownSync(DurableProvisionRequest);
const id = (index: number) =>
  ProvisionRequestId.make(`11111111-1111-4111-a111-${String(index).padStart(12, "0")}`);

it.effect(
  "discovery survives SQLite reopen and exposes only retained matching identities without renewal",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = path.join(directory, "manager.sqlite");
      const layer = ProvisionOperationStore.layer.pipe(
        Layer.provideMerge(makeSqlitePersistenceLive(database)),
      );
      let retainedExpiry = "";
      yield* Effect.gen(function* () {
        const store = yield* ProvisionOperationStore;
        const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
        for (let index = 1; index <= 11; index++) {
          const operation = yield* store.accept(
            decodeRequest({
              requestId: id(index),
              ...(index === 8
                ? { retentionDeadline: "1960-01-01T00:00:00.000Z" }
                : index === 9
                  ? { retentionDeadline: "1970-01-01T00:01:00.000Z" }
                  : {}),
              provider: "e2b",
              providerInstanceId: "account",
              sourceRevision: null,
              repository: "proof/repository",
              preparationHash: "a".repeat(64),
              strategy: "direct",
              templateId: "fixture",
            }),
          );
          if (index !== 3)
            yield* store.advance(operation, {
              kind: "ready",
              allocation: {
                kind: "direct",
                resource: { provider: "e2b", sandboxId: `sandbox-${index}` },
              },
              readiness: {
                environmentId: EnvironmentId.make(`environment-${index}`),
                projectDir: "/private/project",
                sourceRevision: null,
                t3Revision: "b".repeat(40),
                artifactSha256: "c".repeat(64),
                preparationHash: "a".repeat(64),
              },
            });
          const lease = yield* Effect.promise(() =>
            registry.register({
              leaseId: id(index),
              sandboxId: index === 6 ? "wrong-resource" : `sandbox-${index}`,
              provider: "e2b",
              providerInstanceId: "account",
              ...(index === 4 ? { now: expiredAt } : {}),
            }),
          );

          if (index !== 2 && index !== 4)
            yield* Effect.promise(() =>
              registry.claim({
                leaseId: id(index),
                owner: {
                  environmentId: index === 5 ? "wrong-environment" : `environment-${index}`,
                  threadId: `thread-${index}`,
                },
              }),
            );
          if (index === 1) {
            const current = yield* Effect.promise(() => registry.findBySandbox(lease.sandboxId));
            if (current === null) throw new Error("Expected retained lease");
            retainedExpiry = current.expiresAt;
          }
          if (index === 7) yield* Effect.promise(() => registry.markDisposed(id(index)));
          if (index === 10) yield* Effect.promise(() => registry.markPaused(id(index)));
          if (index === 11) yield* Effect.promise(() => registry.markMissing(id(index)));
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const listed = yield* listProvisionedEnvironments(sql);
        expect(listed.map((row) => row.requestId).toSorted()).toEqual([
          id(1),
          id(2),
          id(4),
          id(9),
          id(10),
          id(11),
        ]);
        expect(listed.find((row) => row.requestId === id(1))).toEqual({
          requestId: id(1),
          leaseId: id(1),
          sandboxId: "sandbox-1",
          lifecycle: "active",
          environmentId: "environment-1",
          provider: "e2b",
          label: "proof/repository",
          repository: "proof/repository",
          projectDir: "/private/project",
          threadId: "thread-1",
          createdAt: expect.any(String),
          expiresAt: retainedExpiry,
        });
        expect(listed.find((row) => row.requestId === id(2))?.threadId).toBeNull();
        expect(listed.find((row) => row.requestId === id(2))).toMatchObject({
          leaseId: id(2),
          sandboxId: "sandbox-2",
          lifecycle: "active",
        });
        expect(listed.find((row) => row.requestId === id(4))).toMatchObject({
          leaseId: id(4),
          sandboxId: "sandbox-4",
          lifecycle: "active",
        });
        expect(listed.find((row) => row.requestId === id(9))?.expiresAt).toBe(
          "1970-01-01T00:01:00.000Z",
        );
        expect(listed.find((row) => row.requestId === id(10))).toMatchObject({
          leaseId: id(10),
          sandboxId: "sandbox-10",
          lifecycle: "paused",
          threadId: "thread-10",
        });
        expect(listed.find((row) => row.requestId === id(11))).toMatchObject({
          leaseId: id(11),
          sandboxId: "sandbox-11",
          lifecycle: "missing",
          threadId: "thread-11",
        });
        expect(yield* listProvisionedEnvironments(sql)).toEqual(listed);
        expect(
          (yield* Effect.promise(() =>
            createProvisionedLeaseRegistry(sql).findBySandbox("sandbox-1"),
          ))?.expiresAt,
        ).toBe(retainedExpiry);
      }).pipe(Effect.provide(makeSqlitePersistenceLive(database)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
