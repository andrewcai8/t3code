// @effect-diagnostics globalDate:off - the HTTP provider fixture uses the real wall clock.
// @effect-diagnostics globalDateInEffect:off - actual SDK timeouts are checked against the provider wall clock.
// @effect-diagnostics nodeBuiltinImport:off - the actual SDK talks to an isolated HTTP provider fixture.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DurableProvisionRequest,
  EnvironmentId,
  type ProvisionOperation,
  type ProvisionReadiness,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { makeE2bProvisionRuntime } from "./E2bProvisionRuntime.ts";
import { makeE2bAllocationPorts } from "./E2bProvisionAllocation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderError, ProvisionProviderPorts } from "./Provisioning.ts";

const request = Schema.decodeUnknownSync(DurableProvisionRequest)({
  requestId: "26d53765-3f84-4688-90f6-7c7d26b890cc",
  provider: "e2b",
  providerInstanceId: "codex",
  repository: "example/app",
  sourceRevision: "a".repeat(40),
  preparationHash: "b".repeat(64),
  templateId: "template-id",
  strategy: "fork",
});
const operation: ProvisionOperation = {
  request,
  requestHash: "c".repeat(64),
  revision: 1,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  state: { kind: "create_issued" },
};
const readiness: ProvisionReadiness = {
  environmentId: EnvironmentId.make("environment-from-fixture"),
  projectDir: "/home/user/work/app",
  sourceRevision: "a".repeat(40),
  preparationHash: "b".repeat(64),
  t3Revision: "d".repeat(40),
  artifactSha256: "f".repeat(64),
};
const decodeCreate = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      templateID: Schema.String,
      metadata: Schema.Record(Schema.String, Schema.String),
      timeout: Schema.Int,
      network: Schema.optional(Schema.Unknown),
      autoPause: Schema.optional(Schema.Boolean),
    }),
  ),
);
const decodeTimeout = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ timeout: Schema.Int })),
);
const decodeFork = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ count: Schema.Int, timeout: Schema.Int })),
);
function sandbox(sandboxID: string, metadata: Record<string, string>, templateID = "template-id") {
  return {
    sandboxID,
    templateID,
    metadata,
    envdVersion: "0.6.2",
    domain: "e2b.dev",
    startedAt: "2026-09-13T00:00:00Z",
    endAt: "2026-09-13T06:00:00Z",
    state: "running",
    cpuCount: 2,
    memoryMB: 512,
  };
}
async function providerHttp(drop?: "create" | "fork") {
  const resources: ReturnType<typeof sandbox>[] = [];
  const creates: ReturnType<typeof decodeCreate>[] = [];
  const forks: ReturnType<typeof decodeFork>[] = [];
  const listQueries: URLSearchParams[] = [];
  const timeouts: number[] = [];
  const connects: number[] = [];
  const errors: string[] = [];
  const state: { pages: ReturnType<typeof sandbox>[][] | null; drop: typeof drop; drift: boolean } =
    {
      pages: null,
      drop,
      drift: false,
    };
  const server = NodeHttp.createServer(async (req, res) => {
    try {
      if (req.headers["x-api-key"] !== "fixture-private-key") {
        res.writeHead(401);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url.pathname === "/sandboxes") {
        const parsed = decodeCreate(body);
        creates.push(parsed);
        const resource = sandbox(`parent-${creates.length}`, parsed.metadata, parsed.templateID);
        resource.endAt = new Date(
          Date.now() + parsed.timeout * 1000 + (state.drift ? 60_000 : 0),
        ).toISOString();
        resources.push(resource);
        if (state.drop === "create") {
          state.drop = undefined;
          res.destroy();
          return;
        }
        res.writeHead(201);
        res.end(JSON.stringify(resource));
        return;
      }
      const parentId = url.pathname.split("/")[2];
      const parent = resources.find((item) => item.sandboxID === parentId);
      if (req.method === "POST" && url.pathname.endsWith("/fork") && parent) {
        const parsed = decodeFork(body);
        forks.push(parsed);
        const resource = sandbox(
          `child-${forks.length}`,
          { ...parent.metadata },
          parent.templateID,
        );
        resource.endAt = new Date(
          Date.now() + parsed.timeout * 1000 + (state.drift ? 60_000 : 0),
        ).toISOString();
        resources.push(resource);
        if (state.drop === "fork") {
          state.drop = undefined;
          res.destroy();
          return;
        }
        res.writeHead(201);
        res.end(JSON.stringify([{ sandbox: resource }]));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v2/sandboxes") {
        listQueries.push(url.searchParams);
        const page = Number(url.searchParams.get("nextToken") ?? 0);
        const pages = state.pages ?? [resources];
        if (page + 1 < pages.length) res.setHeader("X-Next-Token", String(page + 1));
        res.end(JSON.stringify(pages[page] ?? []));
        return;
      }
      if (
        req.method === "POST" &&
        parent &&
        (url.pathname.endsWith("/timeout") || url.pathname.endsWith("/connect"))
      ) {
        const parsed = decodeTimeout(body);
        (url.pathname.endsWith("/timeout") ? timeouts : connects).push(parsed.timeout);
        parent.endAt = new Date(
          Date.now() + parsed.timeout * 1000 + (state.drift ? 60_000 : 0),
        ).toISOString();
        res.writeHead(url.pathname.endsWith("/timeout") ? 204 : 201);
        res.end(url.pathname.endsWith("/timeout") ? undefined : JSON.stringify(parent));
        return;
      }
      if (req.method === "DELETE" && parent) {
        resources.splice(resources.indexOf(parent), 1);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && parent) {
        res.end(JSON.stringify(parent));
        return;
      }
      res.writeHead(404);
      res.end('{"code":404,"message":"fixture not found"}');
    } catch (error) {
      errors.push(String(error));
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected fixture TCP address");
  return {
    resources,
    creates,
    forks,
    listQueries,
    timeouts,
    connects,
    errors,
    state,
    config: {
      connection: {
        apiKey: "fixture-private-key",
        validateApiKey: false,
        apiUrl: `http://127.0.0.1:${address.port}`,
        requestTimeoutMs: 5_000,
      },
      parentTimeoutMs: 600_000,
      sandboxTimeoutMs: 21_600_000,
      network: { denyOut: ["0.0.0.0/0"], allowOut: ["github.com"] },
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
const fixture = (drop?: "create" | "fork") =>
  Effect.acquireRelease(
    Effect.promise(() => providerHttp(drop)),
    (provider) => Effect.promise(provider.close),
  );

it.effect("actual SDK binds allocation identity and validates every recovery page", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ports = makeE2bAllocationPorts(f.config);
    const parent = yield* ports.create(operation);
    expect(parent).toEqual({ provider: "e2b", sandboxId: "parent-1" });
    if (parent.provider !== "e2b") throw new Error("Expected E2B fixture");
    const child = yield* ports.fork(operation, parent);
    expect(child).toEqual({ provider: "e2b", sandboxId: "child-1" });
    expect(f.creates).toEqual([
      {
        templateID: "template-id",
        timeout: 600,
        metadata: {
          purpose: "t3-environment",
          account: "codex",
          provision_request_id: request.requestId,
          provision_request_hash: "c".repeat(64),
          provision_template_id: "template-id",
          preparation_hash: "b".repeat(64),
        },
        network: { denyOut: ["0.0.0.0/0"], allowOut: ["github.com"] },
        autoPause: true,
      },
    ]);
    expect(f.forks).toEqual([{ count: 1, timeout: 21_600 }]);
    const original = f.resources[0];
    const forked = f.resources[1];
    if (!original || !forked) throw new Error("Expected created parent and child");
    f.state.pages = [
      [original, sandbox("foreign-account", { ...original.metadata, account: "other" })],
      [
        sandbox("foreign-hash", { ...original.metadata, provision_request_hash: "other" }),
        sandbox("foreign-request", { ...original.metadata, provision_request_id: "other" }),
        sandbox("foreign-preparation", { ...original.metadata, preparation_hash: "other" }),
        sandbox("foreign-template-metadata", {
          ...original.metadata,
          provision_template_id: "other",
        }),
        sandbox("foreign-template", original.metadata, "other-template"),
        forked,
        original,
      ],
    ];
    expect(yield* ports.recoverFork(operation, parent)).toEqual([parent, child]);
    expect(f.listQueries.map((query) => query.get("nextToken"))).toEqual([null, "1"]);
    expect(
      new URLSearchParams(f.listQueries[0]?.get("metadata") ?? "").get("provision_request_hash"),
    ).toBe("c".repeat(64));
    expect(f.errors).toEqual([]);
  }),
);

it.effect("direct allocation uses the sandbox lifetime and refuses a fork", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ports = makeE2bAllocationPorts(f.config);
    const direct = {
      ...operation,
      request: { ...request, provider: "e2b", templateId: "template-id", strategy: "direct" },
    } satisfies ProvisionOperation;
    const created = yield* ports.create(direct);
    expect(created).toEqual({ provider: "e2b", sandboxId: "parent-1" });
    expect(f.creates[0]?.timeout).toBe(21_600);
    expect(f.creates[0]?.autoPause).toBe(true);
    if (created.provider !== "e2b") throw new Error("Expected E2B fixture");
    const refused = yield* ports.fork(direct, created).pipe(Effect.flip);
    expect(refused.message).toBe("Direct E2B allocation cannot fork");
    expect(f.resources.map((resource) => resource.sandboxID)).toEqual(["parent-1"]);
  }),
);

it.effect.each(["create", "fork"] as const)(
  "recovers a lost SDK %s response through the durable service and kills only the parent",
  (drop) =>
    Effect.gen(function* () {
      const f = yield* fixture(drop);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "e2b-provision-operation-" }),
        "state.sqlite",
      );
      const ports: ProvisionProviderPorts["Service"] = {
        ...makeE2bAllocationPorts(f.config),
        dispose: (disposed, resource) =>
          Effect.tryPromise({
            try: () =>
              makeE2bProvisionRuntime(f.config.connection).dispose(
                disposed,
                resource.provider === "e2b" ? resource.sandboxId : "",
              ),
            catch: () => new ProvisionProviderError({ message: "Fixture dispose failed" }),
          }),
        prepare: () => Effect.succeed(readiness),
      };
      const makeLayer = () =>
        Provisioning.layer.pipe(
          Layer.provideMerge(ProvisionOperationStore.layer),
          Layer.provide(Layer.succeed(ProvisionProviderPorts, ports)),
          Layer.provide(makeSqlitePersistenceLive(file)),
          Layer.provide(NodeServices.layer),
        );
      const ensure = Effect.gen(function* () {
        return yield* (yield* Provisioning).ensure(request);
      });
      const uncertain = yield* ensure.pipe(Effect.provide(makeLayer()), Effect.scoped);
      expect(uncertain.state.kind).toBe("allocation_unknown");
      const ready = yield* ensure.pipe(Effect.provide(makeLayer()), Effect.scoped);
      expect(ready.state).toEqual({
        kind: "ready",
        allocation: {
          kind: "fork",
          parent: { provider: "e2b", sandboxId: "parent-1" },
          resource: { provider: "e2b", sandboxId: "child-1" },
        },
        readiness,
      });
      expect(f.creates).toHaveLength(1);
      expect(f.forks).toHaveLength(1);
      expect(f.resources.map((resource) => resource.sandboxID)).toEqual(["child-1"]);
      expect(f.errors).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a changed parent's ownership before sending a fork request", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ports = makeE2bAllocationPorts(f.config);
    const parent = yield* ports.create(operation);
    if (parent.provider !== "e2b") throw new Error("Expected E2B fixture");
    const stored = f.resources[0];
    if (!stored) throw new Error("Expected fixture parent");
    stored.metadata.provision_request_hash = "changed";
    const error = yield* ports.fork(operation, parent).pipe(Effect.flip);
    expect(error.message).toBe(
      "E2B fork response is uncertain; recover the existing child before proceeding",
    );
    expect(f.resources.map((resource) => resource.sandboxID)).toEqual(["parent-1"]);
    expect(f.forks).toEqual([]);
  }),
);

it.effect("does not adopt a partial list when recovery exceeds its page limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ports = makeE2bAllocationPorts({ ...f.config, maxRecoveryPages: 1 });
    yield* ports.create(operation);
    f.state.pages = [[...f.resources], [...f.resources]];
    const error = yield* ports.recoverCreate(operation).pipe(Effect.flip);
    expect(error.message).toBe(
      "E2B resource discovery was incomplete; allocation remains unresolved",
    );
    expect(f.creates).toHaveLength(1);
    expect(f.resources.map((resource) => resource.sandboxID)).toEqual(["parent-1"]);
  }),
);

it.effect(
  "actual SDK caps create, fork and repeated connect requests at the immutable deadline",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const cap = new Date(Date.now() + 60_000).toISOString();
      const bounded = { ...operation, request: { ...request, retentionDeadline: cap } };
      const ports = makeE2bAllocationPorts(f.config);
      const parent = yield* ports.create(bounded);
      if (parent.provider !== "e2b") throw new Error("Expected E2B parent");
      const child = yield* ports.fork(bounded, parent);
      const runtime = makeE2bProvisionRuntime(f.config.connection);
      yield* Effect.promise(() => runtime.touch(bounded, child.sandboxId));
      yield* Effect.promise(() => runtime.touch(bounded, child.sandboxId));
      const seconds = [
        ...f.creates.map((r) => r.timeout),
        ...f.forks.map((r) => r.timeout),
        ...f.connects,
      ];
      expect(seconds).toHaveLength(4);
      expect(seconds.every((value) => value > 0 && value <= 59)).toBe(true);
      expect(f.resources.every((resource) => Date.parse(resource.endAt) <= Date.parse(cap))).toBe(
        true,
      );
      expect(f.timeouts).toEqual([]);
      expect(f.errors).toEqual([]);
    }),
);

it.effect(
  "unresolved provider deadline drift allows one shorter correction and retains allocation identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.drift = true;
      const bounded = {
        ...operation,
        request: { ...request, retentionDeadline: new Date(Date.now() + 60_000).toISOString() },
      };
      const ports = makeE2bAllocationPorts(f.config);
      const result = yield* ports.create(bounded).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { retentionFailed: true } });
      expect(f.creates).toHaveLength(1);
      expect(f.timeouts).toHaveLength(1);
      expect(yield* ports.recoverCreate(bounded)).toEqual([
        { provider: "e2b", sandboxId: "parent-1" },
      ]);
      expect(f.errors).toEqual([]);
    }),
);

it.effect("expired requests never allocate, fork or reconnect", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ports = makeE2bAllocationPorts(f.config);
    const parent = yield* ports.create(operation);
    if (parent.provider !== "e2b") throw new Error("Expected E2B parent");
    const expired = {
      ...operation,
      request: { ...request, retentionDeadline: "1960-01-01T00:00:00.000Z" },
    };
    expect((yield* ports.create(expired).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* ports.fork(expired, parent).pipe(Effect.result))._tag).toBe("Failure");
    const runtime = makeE2bProvisionRuntime(f.config.connection);
    expect(
      (yield* Effect.tryPromise(() => runtime.touch(expired, parent.sandboxId)).pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    expect(f.creates).toHaveLength(1);
    expect(f.forks).toEqual([]);
    expect(f.connects).toEqual([]);
    expect(f.timeouts).toEqual([]);
  }),
);

it.effect(
  "actual SDK refuses a reconnect whose deadline remains above the cap after correction",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const bounded = {
        ...operation,
        request: { ...request, retentionDeadline: new Date(Date.now() + 60_000).toISOString() },
      };
      const ports = makeE2bAllocationPorts(f.config);
      const resource = yield* ports.create(bounded);
      if (resource.provider !== "e2b") throw new Error("Expected E2B resource");
      f.state.drift = true;
      const result = yield* Effect.tryPromise(() =>
        makeE2bProvisionRuntime(f.config.connection).touch(bounded, resource.sandboxId),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.connects).toHaveLength(1);
      expect(f.timeouts).toHaveLength(1);
      expect(f.connects[0]).toBeLessThanOrEqual(59);
      expect(f.timeouts[0]).toBeLessThanOrEqual(59);
      expect(f.errors).toEqual([]);
    }),
);
