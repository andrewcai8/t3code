// @effect-diagnostics globalDate:off - run ages are fixed offsets from a fixed clock.
import { DiscoveredProvisionedEnvironment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  automationEnvironmentsToJoin,
  createAutomationJoins,
  recordAutomationJoinFailure,
  type AutomationJoinFailure,
} from "./automationRuns.ts";
import type { ProvisionStorage } from "./storage.ts";

const decodeDiscovered = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment);
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const MINUTE = 60_000;
const requestIds = new Map<string, string>();
const requestIdOf = (name: string) => {
  if (!requestIds.has(name))
    requestIds.set(name, `11111111-1111-4111-a111-${String(requestIds.size).padStart(12, "0")}`);
  return requestIds.get(name)!;
};

const run = (
  name: string,
  patch: {
    readonly minutesAgo?: number;
    readonly lifecycle?: "active" | "paused";
    readonly threadId?: string | null;
  } = {},
) =>
  decodeDiscovered({
    requestId: requestIdOf(name),
    leaseId: requestIdOf(name),
    sandboxId: `sandbox-${name}`,
    lifecycle: patch.lifecycle ?? "active",
    environmentId: `env-${name}`,
    provider: "e2b",
    label: "acme/app",
    repository: "acme/app",
    projectDir: "/workspace/app",
    threadId: patch.threadId === undefined ? `thread-${name}` : patch.threadId,
    automationId: "nightly",
    createdAt: new Date(NOW - (patch.minutesAgo ?? 1) * MINUTE).toISOString(),
    expiresAt: "2100-01-01T00:00:00.000Z",
  });

const toJoin = (
  joinable: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  device: {
    readonly now?: number;
    readonly known?: ReadonlyArray<string>;
    readonly joined?: ReadonlyArray<string>;
    readonly failures?: ReadonlyMap<string, AutomationJoinFailure>;
  } = {},
) =>
  automationEnvironmentsToJoin(joinable, {
    now: device.now ?? NOW,
    known: new Set((device.known ?? []).map((id) => EnvironmentId.make(id))),
    joined: new Set(device.joined ?? []),
    failures: device.failures ?? new Map(),
  }).map((environment) => environment.environmentId);

function memoryStorage(): ProvisionStorage {
  const records = new Map<string, string>();
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      records.set(key, value);
    },
    removeItem: (key) => {
      records.delete(key);
    },
  };
}

const joinOf = (name: string) => ({
  requestId: requestIdOf(name),
  environmentId: EnvironmentId.make(`env-${name}`),
  threadId: ThreadId.make(`thread-${name}`),
  leaseId: requestIdOf(name),
  sandboxId: `sandbox-${name}`,
  managerEnvironmentId: EnvironmentId.make("host"),
});

describe("automationEnvironmentsToJoin", () => {
  it("joins recent, active runs whose chat exists and that this device does not know", () => {
    const { automationId: _, ...clientStarted } = run("client");
    expect(
      toJoin(
        [
          run("recent"),
          run("yesterday", { minutesAgo: 25 * 60 }),
          run("paused", { lifecycle: "paused" }),
          run("no-chat", { threadId: null }),
          run("known"),
          clientStarted,
        ],
        { known: ["env-known"] },
      ),
    ).toEqual(["env-recent"]);
  });

  it("joins at most the 10 newest runs", () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`${index}`, { minutesAgo: index }));
    expect(toJoin(runs.toReversed())).toEqual([
      "env-0",
      "env-1",
      "env-2",
      "env-3",
      "env-4",
      "env-5",
      "env-6",
      "env-7",
      "env-8",
      "env-9",
    ]);
  });

  it("keeps a run removed after it was joined", () => {
    const storage = memoryStorage();
    createAutomationJoins(storage).record(joinOf("removed"));
    const joined = createAutomationJoins(storage)
      .joined()
      .map((join) => join.requestId);
    expect(toJoin([run("removed"), run("new")], { known: [], joined })).toEqual(["env-new"]);
  });

  it("retries a failed join after one, then two minutes, and stops after three failures", () => {
    const once = new Map([[requestIdOf("flaky"), recordAutomationJoinFailure(undefined, NOW)]]);
    expect([
      toJoin([run("flaky")], { now: NOW + MINUTE - 1, failures: once }),
      toJoin([run("flaky")], { now: NOW + MINUTE, failures: once }),
    ]).toEqual([[], ["env-flaky"]]);

    const twice = new Map([
      [
        requestIdOf("flaky"),
        recordAutomationJoinFailure(once.get(requestIdOf("flaky")), NOW + MINUTE),
      ],
    ]);
    expect([
      toJoin([run("flaky")], { now: NOW + 3 * MINUTE - 1, failures: twice }),
      toJoin([run("flaky")], { now: NOW + 3 * MINUTE, failures: twice }),
    ]).toEqual([[], ["env-flaky"]]);

    const thrice = new Map([
      [
        requestIdOf("flaky"),
        recordAutomationJoinFailure(twice.get(requestIdOf("flaky")), NOW + 3 * MINUTE),
      ],
    ]);
    expect(toJoin([run("flaky")], { now: NOW + 60 * MINUTE, failures: thrice })).toEqual([]);
  });
});

describe("createAutomationJoins", () => {
  it("keeps the newest 200 joins across instances and moves a repeat to the end", () => {
    const storage = memoryStorage();
    const joins = createAutomationJoins(storage);
    for (let index = 0; index < 201; index += 1) joins.record(joinOf(`${index}`));
    joins.record(joinOf("5"));
    const reloaded = createAutomationJoins(storage)
      .joined()
      .map((join) => join.environmentId);
    expect([reloaded.length, reloaded[0], reloaded.at(-2), reloaded.at(-1)]).toEqual([
      200,
      "env-1",
      "env-200",
      "env-5",
    ]);
  });

  it("treats unreadable storage as no joins", () => {
    const storage: ProvisionStorage = {
      getItem: () => "{",
      setItem: () => {},
      removeItem: () => {},
    };
    expect(createAutomationJoins(storage).joined()).toEqual([]);
  });
});
