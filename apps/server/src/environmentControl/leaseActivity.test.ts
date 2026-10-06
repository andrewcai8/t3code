// @effect-diagnostics nodeBuiltinImport:off - these tests serve a fake remote T3 over local HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { assert, it as effectIt } from "@effect/vitest";
import { USAGE_CONTRACT_VERSION, UsageSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { BoxUsageStore } from "../usage/boxUsage.ts";
import { observeLease, pullLeaseUsage, readLeaseUsage, shellActivity } from "./leaseActivity.ts";
import { ownerChat } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";
import type { ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";

vi.mock("./provisionedChats.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./provisionedChats.ts")>();
  return { ...original, ownerChat: vi.fn(original.ownerChat) };
});

const thread = (fields: Record<string, unknown>) =>
  boxThread("thread", "project-app", "Chat", fields);
const request = (kind: string) => ({ id: "request", kind, createdAt: "2026-09-30T10:03:00.000Z" });
const task = (kind: string) => ({ taskId: `task-${kind}`, kind });
const v1Thread = (fields: Record<string, unknown>) => ({
  id: "thread",
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...fields,
});
const v1Session = (status: string) => ({ threadId: "thread", status, activeTurnId: null });

describe("shellActivity", () => {
  it.each([
    ["a preparing run", [thread({ status: "preparing" })], "busy"],
    ["a queued run", [thread({ status: "queued" })], "busy"],
    ["a running run", [thread({ status: "running", activityRunStatus: "running" })], "busy"],
    [
      "a starting activity run",
      [thread({ status: "idle", activityRunStatus: "starting" })],
      "busy",
    ],
    [
      "a pending approval",
      [thread({ status: "waiting", pendingRuntimeRequest: request("command_execution_approval") })],
      "busy",
    ],
    ["a background subagent", [thread({ pendingBackgroundTasks: [task("subagent")] })], "busy"],
    ["one busy chat among idle ones", [thread({}), thread({ status: "running" })], "busy"],
    [
      "a question for the user",
      [
        thread({
          status: "waiting",
          activityRunStatus: "waiting",
          pendingRuntimeRequest: request("user_input"),
        }),
      ],
      "idle",
    ],
    ["a monitor watch loop", [thread({ pendingBackgroundTasks: [task("monitor")] })], "idle"],
    ["a completed run", [thread({ status: "completed" })], "idle"],
    [
      "an archived running chat",
      [thread({ archivedAt: "2026-01-01T00:00:00.000Z", status: "running" })],
      "idle",
    ],
    ["no chats", [], "idle"],
    ["a pre-V2 running session", [v1Thread({ session: v1Session("running") })], "busy"],
    ["a pre-V2 pending approval", [v1Thread({ hasPendingApprovals: true })], "busy"],
    ["pre-V2 working background agents", [v1Thread({ backgroundLiveness: "working" })], "busy"],
    ["a pre-V2 ready session", [v1Thread({ session: v1Session("ready") })], "idle"],
    [
      "an unrecognized pre-V2 session status",
      [v1Thread({ session: v1Session("thinking") })],
      "unknown",
    ],
    ["an unrecognized run status", [thread({ status: "pondering" })], "unknown"],
  ])("reads $0 as $2", (_name, threads, expected) => {
    expect(shellActivity({ snapshotSequence: 1, projects: [], threads })).toBe(expected);
  });

  it("reads an error body as unknown", () => {
    expect(shellActivity({ _tag: "EnvironmentAuthError" })).toBe("unknown");
  });
});

describe("observeLease", () => {
  it("reads the box's shell with the broker token as its activity and its owner's chat", async () => {
    const server = NodeHttp.createServer((request, response) => {
      if (
        request.url !== "/api/orchestration/shell" ||
        request.headers.authorization !== "Bearer broker" ||
        request.headers["x-t3-orchestration-protocol"] !== "2"
      ) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          boxShell([
            boxThread("thread-owner", "project-app", "Fix the login redirect", {
              status: "running",
              activityRunStatus: "running",
            }),
          ]),
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
    const lease = (remoteAccess?: ProvisionedLease["remoteAccess"], owned = true) =>
      ({
        leaseId: "lease",
        owner: owned ? { environmentId: "box", threadId: "thread-owner" } : null,
        ...(remoteAccess ? { remoteAccess } : {}),
      }) as ProvisionedLease;
    try {
      const observed = await observeLease(lease({ origin, brokerToken: "broker" }));
      expect(observed.activity).toBe("busy");
      expect([
        observed.chat?.sequence,
        observed.chat?.thread.title,
        observed.chat?.project.id,
      ]).toEqual([42, "Fix the login redirect", "project-app"]);
      expect(await observeLease(lease({ origin, brokerToken: "broker" }, false))).toEqual({
        activity: "busy",
        chat: null,
      });
      vi.mocked(ownerChat).mockImplementationOnce(() => {
        throw new Error("unexpected shell");
      });
      expect(
        await observeLease(lease({ origin, brokerToken: "broker" })),
        "a chat that cannot be read never hides a busy box",
      ).toEqual({ activity: "busy" });
      expect(await observeLease(lease({ origin, brokerToken: "stale" }))).toEqual({
        activity: "unknown",
      });
      expect(await observeLease(lease())).toEqual({ activity: "unknown" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await observeLease(lease({ origin, brokerToken: "broker" }))).toEqual({
      activity: "unknown",
    });
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

const encodeHistory = Schema.encodeSync(Schema.fromJsonString(UsageSummary));

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
                body === '{"sinceTime":"2026-09-01T02:30:00.000Z"}';
              response.writeHead(expected ? 200 : 400, { "content-type": "application/json" });
              response.end(expected ? encodeHistory(history) : "{}");
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
      const rows = yield* store.list(
        "2026-09-01T00:00:00.000Z",
        "2026-09-02T00:00:00.000Z",
        "2026-08-31T00:00:00.000Z",
      );
      assert.deepStrictEqual(rows, [
        {
          leaseId: "lease-a",
          accountIds: ["codex", "claude"],
          sources: [
            {
              ...history.sources[0]!,
              fingerprint: { ...history.sources[0]!.fingerprint, hostId: "lease-a" },
            },
          ],
          buckets: history.buckets,
          pulledAt: "1970-01-01T00:00:00.000Z",
          retired: true,
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(BoxUsageStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
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
