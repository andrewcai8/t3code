// @effect-diagnostics nodeBuiltinImport:off - the store is exercised against a real private directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ProvisionOperation,
  ProvisionRequestId,
  type ProvisionOperationState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  makeWarmBaseStore,
  makeWarmBaseUpkeep,
  nextWarmStep,
  selectWarmTemplate,
  warmBasePolicy,
  type WarmBaseRecord,
  type WarmBaseSeed,
} from "./warmBases.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const iso = (millis: number) => new Date(millis).toISOString();
const KEY = "1".repeat(64);
const OLD_KEY = "0".repeat(64);
const REVISION = "a".repeat(40);
const policy = warmBasePolicy(12);
const seed = { providerInstanceId: "codex" } as WarmBaseSeed;
const record = (fields: Partial<WarmBaseRecord> = {}): WarmBaseRecord => ({
  repository: "example/repo",
  seed,
  ready: null,
  build: null,
  lastFailure: null,
  retired: [],
  ...fields,
});
const ready = (key: string, builtAt: number, id = "base") => ({
  key,
  snapshotId: `${id}:default`,
  templateId: id,
  sourceRevision: REVISION,
  builtAt: iso(builtAt),
});
const buildId = ProvisionRequestId.make("11111111-1111-4111-a111-000000000001");

describe("choosing a warm base", () => {
  it.each([
    [
      "a fresh base serves chats and needs nothing",
      record({ ready: ready(KEY, NOW - HOUR) }),
      KEY,
      false,
      "base",
      "idle",
    ],
    [
      "an old base is rebuilt but still serves until twice as old",
      record({ ready: ready(KEY, NOW - 13 * HOUR) }),
      KEY,
      false,
      "base",
      "start",
    ],
    [
      "a base past its maximum age serves nobody",
      record({ ready: ready(KEY, NOW - 25 * HOUR) }),
      KEY,
      false,
      null,
      "start",
    ],
    [
      "a base for other inputs serves nobody and is rebuilt",
      record({ ready: ready(OLD_KEY, NOW - HOUR) }),
      KEY,
      false,
      null,
      "start",
    ],
    [
      "a build in flight is driven",
      record({ build: { key: KEY, requestId: buildId, startedAt: iso(NOW - HOUR) } }),
      KEY,
      false,
      null,
      "drive",
    ],
    [
      "a recent failure on the same inputs waits",
      record({ lastFailure: { key: KEY, reason: "x", at: iso(NOW - 0.5 * HOUR) } }),
      KEY,
      true,
      null,
      "idle",
    ],
    [
      "a failure on the same inputs is retried after the backoff",
      record({ lastFailure: { key: KEY, reason: "x", at: iso(NOW - 2 * HOUR) } }),
      KEY,
      false,
      null,
      "start",
    ],
    [
      "a failure on older inputs does not hold back new ones",
      record({ lastFailure: { key: OLD_KEY, reason: "x", at: iso(NOW - 0.5 * HOUR) } }),
      KEY,
      false,
      null,
      "start",
    ],
    ["a repository nobody asked for gets nothing", null, KEY, false, null, "idle"],
    ["a repository a chat started cold for gets a base", null, KEY, true, null, "start"],
  ] as const)("%s", (_name, current, key, wanted, template, step) => {
    expect([
      selectWarmTemplate(current, key, NOW, policy),
      nextWarmStep(current, key, wanted, NOW, policy),
    ]).toEqual([template, step]);
  });

  it("does nothing for a repository that no longer keeps a warm base", () => {
    expect(
      nextWarmStep(record({ ready: ready(KEY, NOW - 30 * HOUR) }), null, true, NOW, policy),
    ).toBe("idle");
  });
});

const decodeOperation = Schema.decodeUnknownSync(ProvisionOperation);
const operation = (requestId: string, state: ProvisionOperationState | { kind: string }) =>
  decodeOperation({
    request: {
      requestId,
      providerInstanceId: "codex",
      sourceRevision: REVISION,
      preparationHash: "b".repeat(64),
      provider: "e2b",
      templateId: "template",
      strategy: "fork",
    },
    requestHash: "c".repeat(64),
    revision: 1,
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
    state,
  });
const allocation = { kind: "direct", resource: { provider: "e2b", sandboxId: "build-box" } };
const readyState = {
  kind: "ready",
  allocation,
  readiness: {
    environmentId: "build-environment",
    projectDir: "/tmp/t3-provision/box/workspace",
    sourceRevision: REVISION,
    t3Revision: "d".repeat(40),
    artifactSha256: "e".repeat(64),
    preparationHash: "b".repeat(64),
  },
};

function harness(initial: WarmBaseRecord[], buildState: { kind: string } = { kind: "intent" }) {
  const clock = { now: NOW };
  const records = new Map(initial.map((entry) => [entry.repository, entry]));
  const states = new Map<string, { kind: string }>();
  const frozen: string[] = [];
  const sealed: string[] = [];
  const deleteAttempts: string[] = [];
  const deleteAnswers = new Map<string, Array<"deleted" | "missing" | "in_use">>();
  const upkeep = makeWarmBaseUpkeep({
    store: {
      list: async () => [...records.values()],
      write: async (entry) => {
        records.set(entry.repository, entry);
      },
    },
    now: () => clock.now,
    key: async () => KEY,
    freezeBuild: async ({ requestId }) => {
      frozen.push(requestId);
      states.set(requestId, buildState);
      return KEY;
    },
    ensure: async (requestId) => operation(requestId, states.get(requestId)!),
    cancel: async (requestId) => operation(requestId, { kind: "disposed" }),
    seal: async (built) => {
      sealed.push(built.request.requestId);
    },
    snapshot: async (built) => ({
      snapshotId: `built-${built.request.requestId}:default`,
      templateId: `built-${built.request.requestId}`,
    }),
    deleteSnapshot: async (snapshotId) => {
      deleteAttempts.push(snapshotId);
      return deleteAnswers.get(snapshotId)?.shift() ?? "deleted";
    },
    warn: () => {},
  });
  return {
    upkeep,
    clock,
    states,
    frozen,
    sealed,
    deleteAttempts,
    deleteAnswers,
    current: () => records.get("example/repo"),
  };
}

describe("warm base upkeep", () => {
  it("makes a finished build the base, retiring the base it replaced and disposing its box", async () => {
    const h = harness([record({ ready: ready(OLD_KEY, NOW - HOUR, "old") })]);
    await h.upkeep.tick(policy);
    const [requestId] = h.frozen;
    expect(h.current()).toEqual(
      record({
        ready: ready(OLD_KEY, NOW - HOUR, "old"),
        build: { key: KEY, requestId: requestId as ProvisionRequestId, startedAt: iso(NOW) },
      }),
    );

    h.states.set(requestId!, readyState);
    h.clock.now += 20 * 60_000;
    await h.upkeep.tick(policy);
    expect([h.sealed, h.current()]).toEqual([
      [requestId],
      record({
        ready: {
          key: KEY,
          snapshotId: `built-${requestId}:default`,
          templateId: `built-${requestId}`,
          sourceRevision: REVISION,
          builtAt: iso(h.clock.now),
        },
        retired: [{ kind: "snapshot", snapshotId: "old:default", retiredAt: iso(h.clock.now) }],
      }),
    ]);
  });

  it("deletes a replaced snapshot only after its grace period, and not while a chat uses it", async () => {
    const leftover = {
      kind: "snapshot" as const,
      snapshotId: "old:default",
      retiredAt: iso(NOW - 10 * 60_000),
    };
    const h = harness([record({ ready: ready(KEY, NOW - HOUR), retired: [leftover] })]);
    h.deleteAnswers.set("old:default", ["in_use", "deleted"]);
    const retired: Array<WarmBaseRecord["retired"] | undefined> = [];
    await h.upkeep.tick(policy);
    retired.push(h.current()?.retired);
    h.clock.now += 55 * 60_000;
    await h.upkeep.tick(policy);
    retired.push(h.current()?.retired);
    await h.upkeep.tick(policy);
    retired.push(h.current()?.retired);
    expect([retired, h.deleteAttempts]).toEqual([
      [[leftover], [leftover], []],
      ["old:default", "old:default"],
    ]);
  });

  it("records why a build failed and waits out the backoff before trying again", async () => {
    const h = harness([], {
      kind: "failed",
      reason: "npm ci exited 1",
      resource: { provider: "e2b", sandboxId: "build-box" },
    });
    h.upkeep.want("Example/Repo", seed);
    const builds: number[] = [];
    await h.upkeep.tick(policy);
    builds.push(h.frozen.length);
    const failed = h.current();
    h.clock.now += 30 * 60_000;
    await h.upkeep.tick(policy);
    builds.push(h.frozen.length);
    h.clock.now += 31 * 60_000;
    await h.upkeep.tick(policy);
    builds.push(h.frozen.length);
    expect([failed, builds]).toEqual([
      record({ lastFailure: { key: KEY, reason: "npm ci exited 1", at: iso(NOW) } }),
      [1, 1, 2],
    ]);
  });
});

it("stores one private record per repository", async () => {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "warm-bases-"));
  try {
    const store = makeWarmBaseStore(stateDir);
    const saved = record({ ready: ready(KEY, NOW) });
    await store.write(saved);
    await store.write({ ...saved, lastFailure: { key: KEY, reason: "later", at: iso(NOW) } });
    expect([
      await store.read("Example/Repo"),
      await store.read("example/other"),
      (await store.list()).length,
    ]).toEqual([{ ...saved, lastFailure: { key: KEY, reason: "later", at: iso(NOW) } }, null, 1]);
  } finally {
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  }
});
