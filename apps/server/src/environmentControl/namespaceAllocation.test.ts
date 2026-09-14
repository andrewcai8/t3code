// @effect-diagnostics nodeBuiltinImport:off - this fixture exercises the SDK's real HTTP serialization.
import * as NodeHttp from "node:http";
import { ProvisionOperation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";

import {
  createNamespaceAllocationClient,
  makeNamespaceAllocationPorts,
  namespaceMacImage,
} from "./namespaceAllocation.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const operation = Schema.decodeUnknownSync(ProvisionOperation)({
  request: {
    requestId: "7314a443-30af-4c88-bc3a-9b70940eb563",
    provider: "namespace",
    creator: "user-test",
    tenantId: "tenant-test",
    providerInstanceId: "codex",
    sourceRevision: null,
    preparationHash: "a".repeat(64),
    size: "m",
    image: namespaceMacImage,
    region: "iad",
    idleTimeoutMinutes: 30,
  },
  requestHash: "b".repeat(64),
  revision: 1,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  state: { kind: "create_issued" },
});

function devbox(id = "box-1") {
  return {
    id,
    name: `t3-${operation.request.requestId}`,
    creator: "user-test",
    site: "iad",
    repository: "",
    imageRef: "",
    accessMode: "USER_PRIVATE",
    workspaceDir: "/Users/runner/workspaces",
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
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function makeFixture(respond: (method: string, body: string) => unknown) {
  const requests: Array<{ method: string; body: string }> = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => {
      const method = request.url?.split("/").pop() ?? "";
      requests.push({ method, body });
      response.setHeader("content-type", "application/json");
      response.end(encodeJson(respond(method, body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const client = await createNamespaceAllocationClient({
    token: "fixture-token",
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  return { client, requests };
}

const fixture = Effect.fn("namespaceAllocation.test.fixture")(
  (respond: Parameters<typeof makeFixture>[0]) => Effect.promise(() => makeFixture(respond)),
);

describe("Namespace durable allocation through the SDK", () => {
  it.effect("refuses a changed account before creating or discovering resources", () =>
    Effect.gen(function* () {
      const server = yield* fixture(() => ({ devboxes: [devbox()] }));
      let creates = 0;
      const ports = makeNamespaceAllocationPorts({
        identity: { creator: "user-test", tenantId: "another-tenant" },
        client: server.client,
        execute: async () => {
          creates += 1;
        },
      });
      expect((yield* Effect.flip(ports.create(operation))).message).toContain("account");
      expect((yield* Effect.flip(ports.recoverCreate(operation))).message).toContain("account");
      expect(creates).toBe(0);
      expect(server.requests).toEqual([]);
    }),
  );
  it.effect(
    "creates the stable named Mac without copying credentials or checking out a mutable branch",
    () =>
      Effect.gen(function* () {
        const server = yield* fixture((method) =>
          method === "List"
            ? { devboxes: [devbox()] }
            : { devbox: devbox(), instanceId: "instance-1" },
        );
        const commands: ReadonlyArray<string>[] = [];
        const ports = makeNamespaceAllocationPorts({
          identity: { creator: "user-test", tenantId: "tenant-test" },
          client: server.client,
          execute: async (args) => {
            commands.push(args);
          },
        });
        expect(yield* ports.create(operation)).toEqual({
          provider: "namespace",
          devboxId: "box-1",
          devboxName: `t3-${operation.request.requestId}`,
          instanceId: "instance-1",
          region: "iad",
          workspaceDir: "/Users/runner/workspaces",
        });
        expect(commands).toEqual([
          [
            "create",
            "--name",
            "t3-7314a443-30af-4c88-bc3a-9b70940eb563",
            "--ephemeral",
            "--activate",
            "--platform",
            "macos/arm64",
            "--size",
            "m",
            "--image",
            "tahoe-xcode-26.4.x-latest",
            "--site",
            "iad",
            "--auto_stop_idle_timeout",
            "30m",
            "--no_checkout",
            "--access_mode",
            "private",
          ],
        ]);
        expect(server.requests.map(({ method }) => method)).toEqual(["List", "Fetch"]);
        expect(decodeJson(server.requests[1]?.body ?? "null")).toMatchObject({
          id: "box-1",
          returnActivatedInstance: true,
        });
      }),
  );

  it.effect("recovers a lost CLI response without another create", () =>
    Effect.gen(function* () {
      const server = yield* fixture((method) =>
        method === "List"
          ? { devboxes: [devbox()] }
          : { devbox: devbox(), instanceId: "instance-1" },
      );
      let creates = 0;
      const ports = makeNamespaceAllocationPorts({
        identity: { creator: "user-test", tenantId: "tenant-test" },
        client: server.client,
        execute: async () => {
          creates += 1;
          throw new Error("lost CLI response");
        },
      });
      expect((yield* Effect.flip(ports.create(operation))).message).toContain("uncertain");
      const recovered = yield* ports.recoverCreate(operation);
      expect(
        recovered.map((resource) =>
          resource.provider === "namespace" ? resource.devboxId : resource.sandboxId,
        ),
      ).toEqual(["box-1"]);
      expect(creates).toBe(1);
    }),
  );

  it.effect(
    "reads every page and returns every matching candidate so ambiguity remains visible",
    () =>
      Effect.gen(function* () {
        const server = yield* fixture((method, body) => {
          if (method === "Fetch")
            return {
              devbox: devbox(body.includes("box-2") ? "box-2" : "box-1"),
              instanceId: "instance",
            };
          if (body.includes("bmV4dA==")) return { devboxes: [devbox("box-2")] };
          return {
            devboxes: [devbox(), { ...devbox("foreign"), creator: "another-user" }],
            paginationCursor: "bmV4dA==",
          };
        });
        let creates = 0;
        const ports = makeNamespaceAllocationPorts({
          identity: { creator: "user-test", tenantId: "tenant-test" },
          client: server.client,
          execute: async () => {
            creates += 1;
          },
        });
        const recovered = yield* ports.recoverCreate(operation);
        expect(recovered).toHaveLength(2);
        expect(server.requests.map(({ method }) => method)).toEqual([
          "List",
          "List",
          "Fetch",
          "Fetch",
        ]);
        expect(creates).toBe(0);
      }),
  );

  it.effect("rejects mismatched owner, image selectors, platform, site and checkout metadata", () =>
    Effect.gen(function* () {
      const server = yield* fixture(() => ({
        devboxes: [
          { ...devbox("owner"), creator: "foreign" },
          { ...devbox("image"), instanceShape: { ...devbox().instanceShape, selectors: [] } },
          { ...devbox("os"), instanceShape: { ...devbox().instanceShape, os: "linux" } },
          { ...devbox("site"), site: "zrh" },
          { ...devbox("repository"), repository: "https://github.com/other/repo" },
        ],
      }));
      const ports = makeNamespaceAllocationPorts({
        identity: { creator: "user-test", tenantId: "tenant-test" },
        client: server.client,
        execute: async () => {
          throw new Error("must not create");
        },
      });
      expect(yield* ports.recoverCreate(operation)).toEqual([]);
      expect(server.requests.map(({ method }) => method)).toEqual(["List"]);
    }),
  );

  it.effect("keeps inactive resources unresolved without activating or recreating them", () =>
    Effect.gen(function* () {
      const server = yield* fixture((method) =>
        method === "List" ? { devboxes: [devbox()] } : { devbox: devbox() },
      );
      const ports = makeNamespaceAllocationPorts({
        identity: { creator: "user-test", tenantId: "tenant-test" },
        client: server.client,
        execute: async () => {
          throw new Error("must not create");
        },
      });
      expect((yield* Effect.flip(ports.recoverCreate(operation))).message).toContain("unresolved");
    }),
  );

  it.effect("never returns partial matches when discovery is truncated", () =>
    Effect.gen(function* () {
      const server = yield* fixture(() => ({ devboxes: [devbox()], paginationCursor: "bmV4dA==" }));
      const ports = makeNamespaceAllocationPorts({
        identity: { creator: "user-test", tenantId: "tenant-test" },
        client: server.client,
        execute: async () => {},
        maxRecoveryPages: 1,
      });
      expect((yield* Effect.flip(ports.recoverCreate(operation))).message).toContain("unresolved");
      expect(server.requests.map(({ method }) => method)).toEqual(["List"]);
    }),
  );
});
