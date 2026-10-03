// @effect-diagnostics globalDate:off globalDateInEffect:off - fixed historical timestamps exercise expiry.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DurableProvisionRequest,
  EnvironmentId,
  type ProvisionOperation,
  ProvisionRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { boxLabel, listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { createProvisionedChatStore, ownerChat } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";
import { Provisioning, ProvisionProviderPorts } from "./Provisioning.ts";

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
        for (let index = 1; index <= 12; index++) {
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
          if (index === 12)
            yield* Effect.promise(() =>
              registry.beginRelease({ leaseId: id(index), sandboxId: `sandbox-${index}` }),
            );
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, request_id,
            prompt, provision_input, state, child_environment_id, thread_id, error, created_at,
            updated_at)
          VALUES ('run-2', 'nightly', 'cron', NULL, ${id(2)}, 'Run.', '{}', 'attaching', NULL,
            NULL, NULL, '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z')
        `;
        const listed = yield* listProvisionedEnvironments(sql);
        expect(listed.map((row) => row.requestId).toSorted()).toEqual([
          id(1),
          id(2),
          id(4),
          id(9),
          id(10),
          id(11),
          id(12),
        ]);
        expect(listed.find((row) => row.requestId === id(1))).toEqual({
          requestId: id(1),
          leaseId: id(1),
          sandboxId: "sandbox-1",
          lifecycle: "active",
          environmentId: "environment-1",
          provider: "e2b",
          label: "repository · E2B",
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
          automationId: "nightly",
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
        // A box being paused stays listed, so clients do not take a pause for a deletion.
        expect(listed.find((row) => row.requestId === id(12))).toMatchObject({
          leaseId: id(12),
          lifecycle: "paused",
          threadId: "thread-12",
        });
        expect(listed.find((row) => row.requestId === id(11))).toMatchObject({
          leaseId: id(11),
          sandboxId: "sandbox-11",
          lifecycle: "missing",
          threadId: "thread-11",
        });
        expect(yield* listProvisionedEnvironments(sql)).toEqual(listed);
        const withSaved = yield* listProvisionedEnvironments(sql, [
          EnvironmentId.make("environment-7"),
          EnvironmentId.make("environment-8"),
          EnvironmentId.make("environment-never-provisioned"),
        ]);
        expect(withSaved.filter((row) => row.lifecycle !== "disposed")).toEqual(listed);
        expect(
          withSaved
            .filter((row) => row.lifecycle === "disposed")
            .toSorted((left, right) => left.requestId.localeCompare(right.requestId)),
        ).toEqual([
          {
            requestId: id(7),
            leaseId: id(7),
            sandboxId: "sandbox-7",
            lifecycle: "disposed",
            environmentId: "environment-7",
            provider: "e2b",
            label: "repository · E2B",
            repository: "proof/repository",
            projectDir: "/private/project",
            threadId: "thread-7",
            createdAt: expect.any(String),
            expiresAt: expect.any(String),
          },
          {
            requestId: id(8),
            leaseId: id(8),
            sandboxId: "sandbox-8",
            lifecycle: "disposed",
            environmentId: "environment-8",
            provider: "e2b",
            label: "repository · E2B",
            repository: "proof/repository",
            projectDir: "/private/project",
            threadId: "thread-8",
            createdAt: expect.any(String),
            expiresAt: "1960-01-01T00:00:00.000Z",
          },
        ]);
        expect(
          yield* listProvisionedEnvironments(sql, [EnvironmentId.make("environment-10")]),
        ).toEqual(listed);
        expect(
          (yield* Effect.promise(() =>
            createProvisionedLeaseRegistry(sql).findBySandbox("sandbox-1"),
          ))?.expiresAt,
        ).toBe(retainedExpiry);
      }).pipe(Effect.provide(makeSqlitePersistenceLive(database)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const boxEnvironment = (operation: ProvisionOperation) =>
  EnvironmentId.make(`box-${operation.request.requestId.slice(-1)}`);
const sandboxOf = (operation: ProvisionOperation) =>
  `sandbox-${operation.request.requestId.slice(-1)}`;
const boxPorts: ProvisionProviderPorts["Service"] = {
  create: (operation) => Effect.succeed({ provider: "e2b", sandboxId: sandboxOf(operation) }),
  recoverCreate: () => Effect.succeed([]),
  fork: () => Effect.die("unused"),
  recoverFork: () => Effect.succeed([]),
  prepare: (operation) =>
    Effect.succeed({
      environmentId: boxEnvironment(operation),
      projectDir: "/home/user/work/app",
      sourceRevision: null,
      t3Revision: "b".repeat(40),
      artifactSha256: "c".repeat(64),
      preparationHash: "a".repeat(64),
    }),
  dispose: () => Effect.void,
};

it.effect("a box disposed through the host is reported disposed, by the id the box reported", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const database = path.join(yield* fs.makeTempDirectoryScoped(), "manager.sqlite");
    yield* Effect.gen(function* () {
      const provisioning = yield* Provisioning;
      const store = yield* ProvisionOperationStore;
      const sql = yield* SqlClient.SqlClient;
      const registry = createProvisionedLeaseRegistry(sql);
      const provision = Effect.fn(function* (index: number, owned: boolean) {
        const operation = yield* provisioning.ensure(
          decodeRequest({
            requestId: id(index),
            provider: "e2b",
            providerInstanceId: "account",
            sourceRevision: null,
            repository: "proof/repository",
            preparationHash: "a".repeat(64),
            strategy: "direct",
            templateId: "fixture",
          }),
        );
        expect(operation.state.kind).toBe("ready");
        yield* Effect.promise(() =>
          registry.register({
            leaseId: id(index),
            sandboxId: sandboxOf(operation),
            provider: "e2b",
            providerInstanceId: "account",
          }),
        );
        if (owned)
          yield* Effect.promise(() =>
            registry.claim({
              leaseId: id(index),
              owner: { environmentId: boxEnvironment(operation), threadId: `thread-${index}` },
            }),
          );
        return operation;
      });
      const dispose = Effect.fn(function* (index: number) {
        expect((yield* provisioning.cancel(id(index))).state.kind).toBe("disposed");
        yield* Effect.promise(() => registry.markDisposed(id(index)));
      });

      yield* provision(1, true);
      yield* dispose(1);
      yield* provision(2, false);
      yield* dispose(2);
      // Before disposal kept the box's identity, it left a bare `disposed` state.
      const legacy = yield* provision(3, true);
      yield* store.advance(legacy, { kind: "disposed" });
      yield* Effect.promise(() => registry.markDisposed(id(3)));
      yield* provision(4, true);
      yield* provision(5, true);
      yield* dispose(5);
      // A client claimed this legacy box for a machine that is not the box. The host must not
      // name that machine a gone box, or every client would mark it missing.
      const misclaimed = yield* provision(6, false);
      yield* Effect.promise(() =>
        registry.claim({
          leaseId: id(6),
          owner: { environmentId: EnvironmentId.make("andrew-megpt-host"), threadId: "thread-6" },
        }),
      );
      yield* store.advance(misclaimed, { kind: "disposed" });
      yield* Effect.promise(() => registry.markDisposed(id(6)));

      const listed = yield* listProvisionedEnvironments(sql, [
        EnvironmentId.make("box-1"),
        EnvironmentId.make("box-2"),
        EnvironmentId.make("box-3"),
        EnvironmentId.make("box-4"),
        EnvironmentId.make("andrew-megpt-host"),
      ]);
      // Only the id a box reported itself names it gone. A legacy row disposed before that id was
      // kept names nothing, since its claimed owner is only what a client said.
      expect(listed.map((row) => [row.environmentId, row.lifecycle, row.threadId])).toEqual([
        ["box-4", "active", "thread-4"],
        ["box-1", "disposed", "thread-1"],
        ["box-2", "disposed", null],
      ]);
      expect(listed[1]).toEqual({
        requestId: id(1),
        leaseId: id(1),
        sandboxId: "sandbox-1",
        lifecycle: "disposed",
        environmentId: "box-1",
        provider: "e2b",
        label: "repository · E2B",
        repository: "proof/repository",
        threadId: "thread-1",
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect((yield* listProvisionedEnvironments(sql)).map((row) => row.environmentId)).toEqual([
        "box-4",
      ]);
    }).pipe(
      Effect.provide(
        Provisioning.layer.pipe(
          Layer.provideMerge(ProvisionOperationStore.layer),
          Layer.provide(Layer.succeed(ProvisionProviderPorts, boxPorts)),
          Layer.provideMerge(makeSqlitePersistenceLive(database)),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a box disposed before the host kept its id is named by the address a client saved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const database = path.join(yield* fs.makeTempDirectoryScoped(), "manager.sqlite");
    yield* Effect.gen(function* () {
      const provisioning = yield* Provisioning;
      const store = yield* ProvisionOperationStore;
      const sql = yield* SqlClient.SqlClient;
      const registry = createProvisionedLeaseRegistry(sql);
      const provision = Effect.fn(function* (index: number, origin: string) {
        const operation = yield* provisioning.ensure(
          decodeRequest({
            requestId: id(index),
            provider: "e2b",
            providerInstanceId: "account",
            sourceRevision: null,
            repository: "proof/repository",
            preparationHash: "a".repeat(64),
            strategy: "direct",
            templateId: "fixture",
          }),
        );
        yield* Effect.promise(() =>
          registry.register({
            leaseId: id(index),
            sandboxId: sandboxOf(operation),
            provider: "e2b",
            providerInstanceId: "account",
          }),
        );
        yield* Effect.promise(() =>
          registry.markActive({
            leaseId: id(index),
            remoteAccess: { origin, brokerToken: "broker" },
          }),
        );
        return operation;
      });
      const disposeBare = Effect.fn(function* (operation: ProvisionOperation) {
        yield* store.advance(operation, { kind: "disposed" });
        yield* Effect.promise(() => registry.markDisposed(operation.request.requestId));
      });

      // Another chat's box, live and claimed.
      yield* provision(1, "https://3773-sandbox-1.e2b.app");
      yield* Effect.promise(() =>
        registry.claim({ leaseId: id(1), owner: { environmentId: "box-1", threadId: "thread-1" } }),
      );
      // A draft's box, paired before boxes were marked and disposed before the host kept its id.
      yield* disposeBare(yield* provision(2, "https://3773-sandbox-2.e2b.app"));
      // The same, for a box this client reached through the host's gateway.
      yield* disposeBare(yield* provision(3, "http://127.0.0.1:44483"));
      // A legacy Namespace box no saved gateway URL names, whose proxy listened on a host port.
      yield* disposeBare(yield* provision(4, "http://127.0.0.1:38041"));

      const saved = [
        ["andrew-megpt-host", "https://andrew.megpt.app/"],
        ["box-1", "https://3773-sandbox-1.e2b.app/"],
        ["legacy-e2b-box", "https://3773-sandbox-2.e2b.app/"],
        ["legacy-gateway-box", `https://andrew.megpt.app/api/provisioned-environment/${id(3)}/`],
        // The user's own server, on the loopback port box 4's proxy used on the host.
        ["desktop-local", "http://127.0.0.1:38041/"],
      ] as const;
      const listed = yield* listProvisionedEnvironments(
        sql,
        saved.map(([environmentId]) => EnvironmentId.make(environmentId)),
        saved.map(([environmentId, httpBaseUrl]) => ({
          environmentId: EnvironmentId.make(environmentId),
          httpBaseUrl,
        })),
      );
      expect(listed.map((row) => [row.environmentId, row.lifecycle, row.leaseId])).toEqual([
        ["box-1", "active", id(1)],
        ["legacy-e2b-box", "disposed", id(2)],
        ["legacy-gateway-box", "disposed", id(3)],
      ]);
    }).pipe(
      Effect.provide(
        Provisioning.layer.pipe(
          Layer.provideMerge(ProvisionOperationStore.layer),
          Layer.provide(Layer.succeed(ProvisionProviderPorts, boxPorts)),
          Layer.provideMerge(makeSqlitePersistenceLive(database)),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a list that asks for chats gets each box's owner chat the client does not hold yet",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const database = path.join(yield* fs.makeTempDirectoryScoped(), "manager.sqlite");
      yield* Effect.gen(function* () {
        const provisioning = yield* Provisioning;
        const sql = yield* SqlClient.SqlClient;
        const registry = createProvisionedLeaseRegistry(sql);
        const chats = createProvisionedChatStore(sql);
        const provision = Effect.fn(function* (index: number) {
          const operation = yield* provisioning.ensure(
            decodeRequest({
              requestId: id(index),
              provider: "e2b",
              providerInstanceId: "account",
              sourceRevision: null,
              repository: "proof/repository",
              preparationHash: "a".repeat(64),
              strategy: "direct",
              templateId: "fixture",
            }),
          );
          yield* Effect.promise(() =>
            registry.register({
              leaseId: id(index),
              sandboxId: sandboxOf(operation),
              provider: "e2b",
              providerInstanceId: "account",
            }),
          );
          yield* Effect.promise(() =>
            registry.claim({
              leaseId: id(index),
              owner: { environmentId: boxEnvironment(operation), threadId: `thread-${index}` },
            }),
          );
        });
        const keepChat = (index: number, threadId: string, title: string) =>
          Effect.promise(() => {
            const chat = ownerChat(boxShell([boxThread(threadId, "project-app", title)]), threadId);
            if (!chat) throw new Error("the fixture shell holds the thread");
            return chats.record(id(index), chat);
          });

        yield* provision(1);
        yield* keepChat(1, "thread-1", "Fix the login redirect");
        // A card whose thread is no longer the lease's owner is never sent.
        yield* provision(2);
        yield* keepChat(2, "thread-other", "Someone else's chat");
        yield* provision(3);
        yield* keepChat(3, "thread-3", "Paused chat");
        yield* Effect.promise(() => registry.markPaused(id(3)));
        yield* provision(4);
        yield* keepChat(4, "thread-4", "Gone chat");
        expect((yield* provisioning.cancel(id(4))).state.kind).toBe("disposed");
        yield* Effect.promise(() => registry.markDisposed(id(4)));

        const listedChats = (
          chatsHeld?: ReadonlyArray<{ readonly environmentId: string; readonly sequence: number }>,
        ) =>
          listProvisionedEnvironments(
            sql,
            [EnvironmentId.make("box-4")],
            [],
            chatsHeld?.map((held) => ({
              ...held,
              environmentId: EnvironmentId.make(held.environmentId),
            })),
          ).pipe(
            Effect.map((rows) =>
              rows.map((row) => [
                row.environmentId,
                row.lifecycle,
                row.chat
                  ? `${row.chat.sequence} ${row.chat.project.id} ${row.chat.thread.title}`
                  : null,
              ]),
            ),
          );
        expect(yield* listedChats()).toEqual([
          ["box-1", "active", null],
          ["box-2", "active", null],
          ["box-3", "paused", null],
          ["box-4", "disposed", null],
        ]);
        expect(yield* listedChats([])).toEqual([
          ["box-1", "active", "42 project-app Fix the login redirect"],
          ["box-2", "active", null],
          ["box-3", "paused", "42 project-app Paused chat"],
          ["box-4", "disposed", null],
        ]);
        expect(
          yield* listedChats([
            { environmentId: "box-1", sequence: 41 },
            { environmentId: "box-3", sequence: 42 },
          ]),
        ).toEqual([
          ["box-1", "active", "42 project-app Fix the login redirect"],
          ["box-2", "active", null],
          ["box-3", "paused", null],
          ["box-4", "disposed", null],
        ]);
        // A kept chat this host can no longer read, as after a contract change.
        yield* sql`
          UPDATE provisioned_chats SET sequence = 50, chat_json = '{"sequence":50}'
          WHERE lease_id = ${id(1)}
        `;
        expect(yield* listedChats([])).toEqual([
          ["box-1", "active", null],
          ["box-2", "active", null],
          ["box-3", "paused", "42 project-app Paused chat"],
          ["box-4", "disposed", null],
        ]);
      }).pipe(
        Effect.provide(
          Provisioning.layer.pipe(
            Layer.provideMerge(ProvisionOperationStore.layer),
            Layer.provide(Layer.succeed(ProvisionProviderPorts, boxPorts)),
            Layer.provideMerge(makeSqlitePersistenceLive(database)),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a paused Devbox lists when it will be removed, or that it is kept", () =>
  Effect.gen(function* () {
    const store = yield* ProvisionOperationStore;
    const sql = yield* SqlClient.SqlClient;
    const registry = createProvisionedLeaseRegistry(sql);
    const chats = createProvisionedChatStore(sql);
    const pausedAt = new Date("2026-03-01T12:00:00.000Z");
    const provision = Effect.fn(function* (index: number) {
      const operation = yield* store.accept(
        decodeRequest({
          requestId: id(index),
          provider: "namespace",
          providerInstanceId: "codex",
          sourceRevision: null,
          preparationHash: "a".repeat(64),
          creator: "user",
          tenantId: "tenant",
          size: "m",
          image: "tahoe",
          region: "iad",
          idleTimeoutMinutes: 30,
        }),
      );
      const resource = {
        provider: "namespace" as const,
        devboxId: `devbox-${index}`,
        devboxName: `t3-${id(index)}`,
        instanceId: "instance",
        region: "iad",
        workspaceDir: "/Users/runner/workspaces",
      };
      yield* store.advance(operation, {
        kind: "ready",
        allocation: { kind: "direct", resource },
        readiness: {
          environmentId: EnvironmentId.make(`box-${index}`),
          projectDir: "/Users/runner/workspaces/app",
          sourceRevision: null,
          t3Revision: "b".repeat(40),
          artifactSha256: "c".repeat(64),
          preparationHash: "a".repeat(64),
        },
      });
      yield* Effect.promise(async () => {
        await registry.register({
          leaseId: id(index),
          sandboxId: resource.devboxId,
          provider: "namespace",
          providerInstanceId: "codex",
          namespaceResource: resource,
          owner: { environmentId: `box-${index}`, threadId: `thread-${index}` },
          now: pausedAt,
        });
        await registry.markPaused(id(index), pausedAt);
      });
    });
    yield* provision(1);
    yield* provision(2);
    yield* Effect.promise(async () => {
      const chat = ownerChat(boxShell([boxThread("thread-2", "project-app", "Done")]), "thread-2");
      if (!chat) throw new Error("the fixture shell holds the thread");
      await chats.record(id(2), {
        ...chat,
        thread: {
          ...chat.thread,
          settledOverride: "settled",
          settledAt: DateTime.makeUnsafe("2026-03-01T11:00:00.000Z"),
        },
      });
    });
    yield* provision(3);
    yield* Effect.promise(() => registry.setKeep(id(3), "user"));

    const cleanups = (afterDays: number | null) =>
      listProvisionedEnvironments(sql, [], [], undefined, afterDays).pipe(
        Effect.map((rows) =>
          rows.map((row) => [row.environmentId, row.cleanup ?? null, row.chat ?? null]),
        ),
      );
    expect(yield* cleanups(7)).toEqual([
      ["box-1", { kind: "scheduled", at: "2026-03-08T12:00:00.000Z", reason: "idle" }, null],
      ["box-2", { kind: "scheduled", at: "2026-03-01T13:00:00.000Z", reason: "settled" }, null],
      ["box-3", { kind: "kept", reason: "user" }, null],
    ]);
    expect(yield* cleanups(null)).toEqual([
      ["box-1", null, null],
      ["box-2", null, null],
      ["box-3", { kind: "kept", reason: "user" }, null],
    ]);
  }).pipe(
    Effect.provide(
      ProvisionOperationStore.layer.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it("labels a box by its repository's name and where it runs", () => {
  const e2b = {
    requestId: id(1),
    provider: "e2b",
    providerInstanceId: "account",
    sourceRevision: null,
    preparationHash: "a".repeat(64),
    strategy: "direct",
    templateId: "fixture",
  };
  const namespace = {
    requestId: id(2),
    provider: "namespace",
    providerInstanceId: "account",
    sourceRevision: null,
    preparationHash: "a".repeat(64),
    tenantId: "tenant",
    size: "M",
    image: "image",
    region: "us",
    idleTimeoutMinutes: 30,
  };
  const label = (request: Record<string, unknown>) => boxLabel(decodeRequest(request));
  expect(label({ ...e2b, repository: "pingdotgg/t3code" })).toBe("t3code · E2B");
  expect(label(e2b)).toBe("E2B");
  expect(label({ ...namespace, repository: "pingdotgg/t3code", engine: "instance" })).toBe(
    "t3code · Namespace Mac",
  );
  expect(label({ ...namespace, engine: "instance" })).toBe("Namespace Mac");
  expect(label({ ...namespace, repository: "pingdotgg/t3code" })).toBe("t3code · Namespace Mac");
  expect(label(namespace)).toBe("Namespace Mac");
});
