import { describe, expect, it } from "@effect/vitest";
import {
  DurableProvisionRequest,
  EnvironmentId,
  type ProvisionAllocation,
  type ProvisionOperationState,
  type ProvisionOperation,
  type ProvisionReadiness,
  type ProvisionResource,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderError, ProvisionProviderPorts } from "./Provisioning.ts";

const decodeRequest = Schema.decodeUnknownEffect(DurableProvisionRequest);

const request = Schema.decodeUnknownSync(DurableProvisionRequest)({
  requestId: "908e75d5-01ec-483f-9858-3ac1fa8c7b23",
  provider: "e2b",
  providerInstanceId: "codex",
  repository: "example/app",
  branch: "main",
  sourceRevision: "a".repeat(40),
  preparationHash: "b".repeat(64),
  templateId: "prepared-template",
  strategy: "fork",
});
const parent = { provider: "e2b", sandboxId: "parent-1" } as const;
const child = { provider: "e2b", sandboxId: "child-1" } as const;
const allocation: ProvisionAllocation = { kind: "fork", parent, resource: child };
const readiness: ProvisionReadiness = {
  environmentId: EnvironmentId.make("stable-environment"),
  projectDir: "/home/user/work/app",
  sourceRevision: "a".repeat(40),
  preparationHash: "b".repeat(64),
  t3Revision: "c".repeat(40),
  artifactSha256: "f".repeat(64),
};
function provider(failAt?: "create" | "fork" | "prepare") {
  const resources: ProvisionResource[] = [];
  let createCount = 0;
  let forkCount = 0;
  let ready: ProvisionReadiness = readiness;
  let failed = false;
  const fail = () =>
    new ProvisionProviderError({ message: "Response lost after provider committed" });
  const ports: ProvisionProviderPorts["Service"] = {
    create: () =>
      Effect.gen(function* () {
        createCount += 1;
        resources.push(parent);
        if (failAt === "create" && !failed) {
          failed = true;
          return yield* fail();
        }
        return parent;
      }),
    recoverCreate: () => Effect.succeed([...resources]),
    fork: () =>
      Effect.gen(function* () {
        forkCount += 1;
        resources.push(child);
        if (failAt === "fork" && !failed) {
          failed = true;
          return yield* fail();
        }
        return child;
      }),
    recoverFork: () => Effect.succeed(resources.filter((resource) => resource.provider === "e2b")),
    dispose: () => Effect.void,
    prepare: () =>
      Effect.gen(function* () {
        if (failAt === "prepare" && !failed) {
          failed = true;
          return yield* fail();
        }
        return ready;
      }),
  };
  return {
    ports,
    resources,
    setReadiness: (value: ProvisionReadiness) => {
      ready = value;
    },
    counts: () => ({ creates: createCount, forks: forkCount }),
  };
}
const makeLayer = (file: string, ports: ProvisionProviderPorts["Service"]) =>
  Provisioning.layer.pipe(
    Layer.provideMerge(ProvisionOperationStore.layer),
    Layer.provide(Layer.succeed(ProvisionProviderPorts, ports)),
    Layer.provide(makeSqlitePersistenceLive(file)),
    Layer.provide(NodeServices.layer),
  );
const temporaryDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "provision-operation-" }),
    "state.sqlite",
  );
});
const ensure = Effect.fn("test.ensureProvision")(function* (input = request) {
  return yield* (yield* Provisioning).ensure(input);
});

describe("durable cloud provisioning", () => {
  it.effect.each(["create", "fork", "prepare"] as const)(
    "recovers a lost %s response after SQLite restart",
    (failure) =>
      Effect.gen(function* () {
        const file = yield* temporaryDatabase;
        const p = provider(failure);
        const first = yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
        expect(first.state.kind).toBe(failure === "prepare" ? "preparing" : "allocation_unknown");
        const resumed = yield* Effect.all([ensure(), ensure(), ensure()], { concurrency: 3 }).pipe(
          Effect.provide(makeLayer(file, p.ports)),
          Effect.scoped,
        );
        const final = yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
        expect(final.state).toEqual({ kind: "ready", allocation, readiness });
        expect(p.counts()).toEqual({ creates: 1, forks: 1 });
        expect(resumed.every((operation) => operation.requestHash === final.requestHash)).toBe(
          true,
        );
        expect(p.resources).toEqual([parent, child]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  const boundaries: ProvisionOperationState[] = [
    { kind: "create_issued" },
    { kind: "parent_allocated", parent },
    { kind: "fork_issued", parent },
    { kind: "allocated", allocation },
    { kind: "preparing", allocation, lastError: null },
    { kind: "ready", allocation, readiness },
  ];
  it.effect.each(boundaries)("resumes persisted $kind without repeating allocation", (state) =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      p.resources.push(parent);
      if (state.kind !== "create_issued" && state.kind !== "parent_allocated")
        p.resources.push(child);
      yield* Effect.gen(function* () {
        const store = yield* ProvisionOperationStore;
        yield* store.advance(yield* store.accept(request), state);
      }).pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      const result = yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      expect(result.state).toEqual({ kind: "ready", allocation, readiness });
      expect(p.counts()).toEqual({
        creates: 0,
        forks: state.kind === "create_issued" || state.kind === "parent_allocated" ? 1 : 0,
      });
      expect(p.resources).toEqual([parent, child]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a fork parent that cannot be killed does not block the ready child", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      const disposed: ProvisionResource[] = [];
      const ports = {
        ...p.ports,
        dispose: (_op: ProvisionOperation, resource: ProvisionResource) =>
          Effect.sync(() => disposed.push(resource)).pipe(
            Effect.andThen(Effect.fail(new ProvisionProviderError({ message: "Kill failed" }))),
          ),
      };
      const result = yield* ensure().pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
      expect(result.state).toEqual({ kind: "ready", allocation, readiness });
      expect(disposed).toEqual([parent]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an uncertain create unresolved through empty and ambiguous discovery", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider("create");
      yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      p.resources.splice(0);
      for (let retry = 0; retry < 3; retry += 1) {
        const result = yield* ensure().pipe(
          Effect.provide(makeLayer(file, p.ports)),
          Effect.scoped,
        );
        expect(result.state).toEqual({
          kind: "allocation_unknown",
          allocation: { kind: "create" },
          reason: "No matching resource is observable yet",
        });
      }
      p.resources.push(parent, { provider: "e2b", sandboxId: "ambiguous-parent" });
      const ambiguous = yield* ensure().pipe(
        Effect.provide(makeLayer(file, p.ports)),
        Effect.scoped,
      );
      expect(ambiguous.state).toEqual({
        kind: "allocation_unknown",
        allocation: { kind: "create" },
        reason: "More than one matching resource exists",
      });
      expect(p.counts()).toEqual({ creates: 1, forks: 0 });
      p.resources.splice(1);
      const recovered = yield* ensure().pipe(
        Effect.provide(makeLayer(file, p.ports)),
        Effect.scoped,
      );
      expect(recovered.state.kind).toBe("ready");
      expect(p.resources).toEqual([parent, child]);
      expect(p.counts()).toEqual({ creates: 1, forks: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not treat a visible parent as the child of an uncertain fork", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider("fork");
      yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      p.resources.splice(1);
      const missing = yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      expect(missing.state).toEqual({
        kind: "allocation_unknown",
        allocation: { kind: "fork", parent },
        reason: "No matching resource is observable yet",
      });
      p.resources.push(child, { provider: "e2b", sandboxId: "extra-child" });
      const ambiguous = yield* ensure().pipe(
        Effect.provide(makeLayer(file, p.ports)),
        Effect.scoped,
      );
      expect(ambiguous.state.kind).toBe("allocation_unknown");
      p.resources.splice(2);
      const recovered = yield* ensure().pipe(
        Effect.provide(makeLayer(file, p.ports)),
        Effect.scoped,
      );
      expect(recovered.state).toEqual({ kind: "ready", allocation, readiness });
      expect(p.counts()).toEqual({ creates: 1, forks: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects changed intent and keeps mismatched preparation unready", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      p.setReadiness({ ...readiness, sourceRevision: "d".repeat(40) });
      const blocked = yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      expect(blocked.state).toEqual({
        kind: "preparing",
        allocation,
        lastError: "Prepared content does not match the immutable request",
      });
      const changed = yield* ensure({ ...request, preparationHash: "e".repeat(64) }).pipe(
        Effect.flip,
        Effect.provide(makeLayer(file, p.ports)),
        Effect.scoped,
      );
      expect(changed).toMatchObject({
        _tag: "ProvisionRequestConflict",
        requestId: request.requestId,
      });
      p.setReadiness(readiness);
      const fixed = yield* ensure().pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      expect(fixed.state).toEqual({ kind: "ready", allocation, readiness });
      expect(p.counts()).toEqual({ creates: 1, forks: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("concurrent preparation uses one stable host identity under the provider lock", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      const firstEntered = yield* Deferred.make<void>();
      const bothEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const lock = yield* Semaphore.make(1);
      let entries = 0;
      let preparations = 0;
      let prepared: ProvisionReadiness | undefined;
      const ports: ProvisionProviderPorts["Service"] = {
        ...p.ports,
        dispose: () => Effect.void,
        prepare: () =>
          Effect.gen(function* () {
            entries += 1;
            yield* Deferred.succeed(entries === 1 ? firstEntered : bothEntered, undefined);
            return yield* Effect.gen(function* () {
              if (prepared) return prepared;
              yield* Deferred.await(release);
              preparations += 1;
              prepared = readiness;
              return prepared;
            }).pipe(lock.withPermits(1));
          }),
      };
      yield* Effect.gen(function* () {
        const first = yield* Effect.forkChild(ensure());
        yield* Deferred.await(firstEntered);
        const second = yield* Effect.forkChild(ensure());
        yield* Deferred.await(bothEntered);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        for (const result of results)
          expect(result.state).toEqual({ kind: "ready", allocation, readiness });
      }).pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
      expect(entries).toBe(2);
      expect(preparations).toBe(1);
      expect(p.resources).toEqual([parent, child]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves a Namespace resource by stable request identity without an E2B fork", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const input = yield* decodeRequest({
        ...request,
        provider: "namespace",
        creator: "user-test",
        tenantId: "tenant-test",
        size: "m",
        image: "macos-image",
        region: "iad",
        idleTimeoutMinutes: 30,
      });
      const resource: ProvisionResource = {
        provider: "namespace",
        devboxId: "devbox-1",
        devboxName: `t3-${request.requestId}`,
        instanceId: "mac-1",
        region: "iad",
        workspaceDir: "/Users/runner/workspaces/app",
      };
      let creations = 0;
      const ports: ProvisionProviderPorts["Service"] = {
        create: () =>
          Effect.gen(function* () {
            creations += 1;
            return yield* new ProvisionProviderError({ message: "CLI response lost" });
          }),
        recoverCreate: () => Effect.succeed([resource]),
        fork: () => Effect.die("Namespace cannot fork E2B"),
        recoverFork: () => Effect.die("Namespace cannot recover E2B forks"),
        dispose: () => Effect.void,
        prepare: () => Effect.succeed({ ...readiness, projectDir: resource.workspaceDir }),
      };
      const uncertain = yield* ensure(input).pipe(
        Effect.provide(makeLayer(file, ports)),
        Effect.scoped,
      );
      expect(uncertain.state.kind).toBe("allocation_unknown");
      const recovered = yield* ensure(input).pipe(
        Effect.provide(makeLayer(file, ports)),
        Effect.scoped,
      );
      expect(recovered.state).toEqual({
        kind: "ready",
        allocation: { kind: "direct", resource },
        readiness: { ...readiness, projectDir: resource.workspaceDir },
      });
      expect(creations).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retains a mismatched provider resource for cleanup", () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const resource: ProvisionResource = {
        provider: "namespace",
        devboxId: "unexpected-devbox",
        devboxName: "unexpected-name",
        instanceId: "unexpected-instance",
        region: "iad",
        workspaceDir: "/Users/runner/workspaces",
      };
      const ports = { ...provider().ports, create: () => Effect.succeed(resource) };
      const result = yield* ensure().pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
      expect(result.state).toEqual({
        kind: "failed",
        reason: "Provider returned a resource of another kind",
        resource,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect("cancel fences an unissued intent and never creates or prepares it", () =>
  Effect.gen(function* () {
    const file = yield* temporaryDatabase;
    const p = provider();
    yield* Effect.gen(function* () {
      const store = yield* ProvisionOperationStore;
      const service = yield* Provisioning;
      yield* store.accept(request);
      expect((yield* service.cancel(request.requestId)).state).toEqual({ kind: "disposed" });
      expect((yield* service.ensure(request)).state).toEqual({ kind: "disposed" });
      expect(p.counts()).toEqual({ creates: 0, forks: 0 });
    }).pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cancel keeps uncertain allocation unresolved until recovery can confirm cleanup", () =>
  Effect.gen(function* () {
    const file = yield* temporaryDatabase;
    const p = provider();
    const disposed: string[] = [];
    const ports = {
      ...p.ports,
      dispose: (_operation: ProvisionOperation, resource: ProvisionResource) =>
        Effect.sync(() => {
          disposed.push(resource.provider === "e2b" ? resource.sandboxId : resource.devboxId);
        }),
    };
    yield* Effect.gen(function* () {
      const store = yield* ProvisionOperationStore;
      const operation = yield* store.accept(request);
      yield* store.advance(operation, { kind: "fork_issued", parent });
      p.resources.push(parent);
      const result = yield* (yield* Provisioning).cancel(request.requestId);
      expect(result.state.kind).toBe("cancel_requested");
      expect(disposed).toEqual([parent.sandboxId]);
    }).pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
    p.resources.push(child);
    yield* Effect.gen(function* () {
      const service = yield* Provisioning;
      expect((yield* service.cancel(request.requestId)).state).toEqual({ kind: "disposed" });
      expect((yield* service.ensure(request)).state).toEqual({ kind: "disposed" });
    }).pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
    expect(disposed).toContain(child.sandboxId);
    expect(p.counts()).toEqual({ creates: 0, forks: 0 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "concurrent cancellation cleans known fork identities and retains a failed cleanup for retry",
  () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      let fail = false;
      const disposed = new Set<string>();
      const ports = {
        ...p.ports,
        dispose: (_operation: ProvisionOperation, resource: ProvisionResource) =>
          Effect.gen(function* () {
            if (fail) {
              fail = false;
              return yield* new ProvisionProviderError({ message: "Cleanup reply lost" });
            }
            disposed.add(resource.provider === "e2b" ? resource.sandboxId : resource.devboxId);
          }),
      };
      yield* Effect.gen(function* () {
        const service = yield* Provisioning;
        yield* service.ensure(request);
        disposed.clear();
        fail = true;
        expect((yield* service.cancel(request.requestId)).state).toMatchObject({
          kind: "cancel_requested",
          lastError: "Cleanup reply lost",
        });
        const results = yield* Effect.all(
          [service.cancel(request.requestId), service.cancel(request.requestId)],
          { concurrency: "unbounded" },
        );
        expect(results.every((result) => result.state.kind === "disposed")).toBe(true);
        expect([...disposed].sort()).toEqual([parent.sandboxId, child.sandboxId].sort());
        expect(p.counts()).toEqual({ creates: 1, forks: 1 });
      }).pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an immutable retention deadline survives restart and rejects a changed deadline", () =>
  Effect.gen(function* () {
    const file = yield* temporaryDatabase;
    const p = provider();
    const bounded = { ...request, retentionDeadline: "2099-01-01T00:00:00.000Z" };
    const first = yield* ensure(bounded).pipe(
      Effect.provide(makeLayer(file, p.ports)),
      Effect.scoped,
    );
    const replay = yield* ensure(bounded).pipe(
      Effect.provide(makeLayer(file, p.ports)),
      Effect.scoped,
    );
    expect(replay.requestHash).toBe(first.requestHash);
    expect(replay.state).toEqual(first.state);
    const changed = yield* ensure({
      ...bounded,
      retentionDeadline: "2099-01-02T00:00:00.000Z",
    }).pipe(Effect.result, Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
    expect(changed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProvisionRequestConflict" },
    });
    expect(p.counts()).toEqual({ creates: 1, forks: 1 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { kind: "intent" },
  { kind: "parent_allocated", parent },
  { kind: "allocated", allocation },
  { kind: "preparing", allocation, lastError: null },
  { kind: "ready", allocation, readiness },
] satisfies ProvisionOperationState[])(
  "expired $kind reconciles cleanup without create, fork or preparation",
  (state) =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      const disposed: ProvisionResource[] = [];
      const ports = {
        ...p.ports,
        prepare: () => Effect.die("Expired preparation must not run"),
        dispose: (_op: ProvisionOperation, resource: ProvisionResource) =>
          Effect.sync(() => {
            disposed.push(resource);
          }),
      };
      const bounded = { ...request, retentionDeadline: "1960-01-01T00:00:00.000Z" };
      yield* Effect.gen(function* () {
        const store = yield* ProvisionOperationStore;
        yield* store.advance(yield* store.accept(bounded), state);
      }).pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped);
      const result = yield* ensure(bounded).pipe(
        Effect.provide(makeLayer(file, ports)),
        Effect.scoped,
      );
      expect(result.state).toEqual({ kind: "disposed" });
      expect(p.counts()).toEqual({ creates: 0, forks: 0 });
      expect(disposed).toEqual(
        state.kind === "intent"
          ? []
          : state.kind === "parent_allocated"
            ? [parent]
            : [child, parent],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "expired uncertain allocation remains cancellable until provider recovery identifies its resource",
  () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      const bounded = { ...request, retentionDeadline: "1960-01-01T00:00:00.000Z" };
      yield* Effect.gen(function* () {
        const store = yield* ProvisionOperationStore;
        yield* store.advance(yield* store.accept(bounded), { kind: "create_issued" });
      }).pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped);
      expect(
        (yield* ensure(bounded).pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped)).state
          .kind,
      ).toBe("cancel_requested");
      p.resources.push(parent);
      expect(
        (yield* ensure(bounded).pipe(Effect.provide(makeLayer(file, p.ports)), Effect.scoped)).state
          .kind,
      ).toBe("disposed");
      expect(p.counts()).toEqual({ creates: 0, forks: 0 });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "failed provider retention proof cancels and disposes the already allocated resource",
  () =>
    Effect.gen(function* () {
      const file = yield* temporaryDatabase;
      const p = provider();
      const disposed: ProvisionResource[] = [];
      const ports = {
        ...p.ports,
        prepare: () =>
          Effect.fail(
            new ProvisionProviderError({
              message: "Provider deadline exceeds cap",
              retentionFailed: true,
            }),
          ),
        dispose: (_op: ProvisionOperation, resource: ProvisionResource) =>
          Effect.sync(() => {
            disposed.push(resource);
          }),
      };
      expect(
        (yield* ensure().pipe(Effect.provide(makeLayer(file, ports)), Effect.scoped)).state,
      ).toEqual({ kind: "disposed" });
      expect(disposed).toEqual([parent, child, parent]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
