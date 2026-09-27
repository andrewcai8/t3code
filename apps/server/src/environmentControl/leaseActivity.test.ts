// @effect-diagnostics nodeBuiltinImport:off - these tests serve a fake remote T3 over local HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { assert, it as effectIt } from "@effect/vitest";
import { USAGE_CONTRACT_VERSION, type UsageSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { BoxUsageStore } from "../usage/boxUsage.ts";
import {
  pullLeaseUsage,
  readLeaseActivity,
  readLeaseUsage,
  shellActivity,
} from "./leaseActivity.ts";
import type { ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";

const thread = (fields: Record<string, unknown>) => ({
  id: "thread",
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...fields,
});
const session = (status: string) => ({ threadId: "thread", status, activeTurnId: null });

describe("shellActivity", () => {
  it.each([
    ["a starting session", [thread({ session: session("starting") })], "busy"],
    ["a running session", [thread({ session: session("running") })], "busy"],
    ["a pending approval", [thread({ hasPendingApprovals: true })], "busy"],
    ["working background agents", [thread({ backgroundLiveness: "working" })], "busy"],
    [
      "one busy chat among idle ones",
      [thread({}), thread({ session: session("running") })],
      "busy",
    ],
    ["a ready session", [thread({ session: session("ready") })], "idle"],
    ["pending user input", [thread({ hasPendingUserInput: true })], "idle"],
    ["a monitoring watch loop", [thread({ backgroundLiveness: "monitoring" })], "idle"],
    [
      "an archived running chat",
      [thread({ archivedAt: "2026-01-01T00:00:00.000Z", session: session("running") })],
      "idle",
    ],
    ["no chats", [], "idle"],
    ["an unrecognized session status", [thread({ session: session("thinking") })], "unknown"],
  ])("reads %s as %s", (_name, threads, expected) => {
    expect(shellActivity({ snapshotSequence: 1, projects: [], threads })).toBe(expected);
  });

  it("reads an error body as unknown", () => {
    expect(shellActivity({ _tag: "EnvironmentAuthError" })).toBe("unknown");
  });
});

describe("readLeaseActivity", () => {
  it("asks the remote shell with the broker token and treats anything else as unknown", async () => {
    const server = NodeHttp.createServer((request, response) => {
      if (
        request.url !== "/api/orchestration/shell" ||
        request.headers.authorization !== "Bearer broker"
      ) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ threads: [thread({ session: session("running") })] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
    const lease = (remoteAccess?: ProvisionedLease["remoteAccess"]) =>
      ({ leaseId: "lease", ...(remoteAccess ? { remoteAccess } : {}) }) as ProvisionedLease;
    try {
      expect(await readLeaseActivity(lease({ origin, brokerToken: "broker" }))).toBe("busy");
      expect(await readLeaseActivity(lease({ origin, brokerToken: "stale" }))).toBe("unknown");
      expect(await readLeaseActivity(lease())).toBe("unknown");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await readLeaseActivity(lease({ origin, brokerToken: "broker" }))).toBe("unknown");
  });
});

const listen = async (handler: NodeHttp.RequestListener) => {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
};

const history: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-01T06:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-09-01" as UsageSummary["sinceDay"],
  untilDay: "2026-09-01" as UsageSummary["untilDay"],
  buckets: [
    {
      day: "2026-09-01" as UsageSummary["sinceDay"],
      hourStart: "2026-09-01T03:00:00.000Z",
      provider: "codex",
      model: "gpt-5.6-sol",
      sourcePath: "/home/user/.codex/sessions",
      totals: {
        uncachedInputTokens: 120,
        cachedInputTokens: 30,
        cacheCreationTokens: 0,
        outputTokens: 45,
        reasoningTokens: 5,
      },
      costUsd: 0.25,
      cacheSavingsUsd: 0.01,
      costSource: "modelPriced",
      records: 3,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId: "e2b-box",
        provider: "codex",
        resolvedHomePath: "/home/user/.codex/sessions",
        volumeId: "2049:11",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 4,
};

describe("pullLeaseUsage", () => {
  effectIt.effect("stores the box's history since the lease was created", () =>
    Effect.gen(function* () {
      const box = yield* Effect.acquireRelease(
        Effect.promise(() =>
          listen((request, response) => {
            let body = "";
            request.on("data", (chunk: Buffer) => (body += chunk.toString()));
            request.on("end", () => {
              const expected =
                request.method === "POST" &&
                request.url === "/api/usage/history" &&
                request.headers.authorization === "Bearer broker" &&
                body === JSON.stringify({ sinceTime: "2026-09-01T02:30:00.000Z" });
              response.writeHead(expected ? 200 : 400, { "content-type": "application/json" });
              response.end(expected ? JSON.stringify(history) : "{}");
            });
          }),
        ),
        (server) => Effect.promise(server.close),
      );
      const store = yield* BoxUsageStore;
      yield* pullLeaseUsage(store, {
        leaseId: "lease-a",
        sandboxId: "sandbox-a",
        providerInstanceId: "codex",
        companionInstanceIds: ["claude"],
        remoteAccess: { origin: box.origin, brokerToken: "broker" },
        state: "active",
        owner: null,
        createdAt: "2026-09-01T02:30:00.000Z",
        updatedAt: "2026-09-01T02:30:00.000Z",
        expiresAt: "2026-09-01T02:45:00.000Z",
      });
      const rows = yield* store.list("2026-09-01T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
      assert.deepStrictEqual(rows, [
        {
          leaseId: "lease-a",
          accountIds: ["codex", "claude"],
          usage: { sources: history.sources, buckets: history.buckets },
          latestHourStart: "2026-09-01T03:00:00.000Z",
          pulledAt: "1970-01-01T00:00:00.000Z",
          retired: true,
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(BoxUsageStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
    ),
  );
});

describe("readLeaseUsage", () => {
  it("gives up on a box that never answers", async () => {
    const box = await listen(() => {});
    try {
      await expect(
        readLeaseUsage(
          {
            leaseId: "lease",
            remoteAccess: { origin: box.origin, brokerToken: "broker" },
          } as ProvisionedLease,
          "2026-09-01T00:00:00.000Z",
          50,
        ),
      ).rejects.toThrow("timeout");
    } finally {
      await box.close();
    }
  });
});
