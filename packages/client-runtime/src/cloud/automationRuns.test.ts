import { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_JOIN_ATTEMPTS_STORAGE_KEY,
  automationEnvironmentsToJoin,
  createAutomationJoinAttempts,
} from "./automationRuns.ts";
import type { ProvisionStorage } from "./storage.ts";

const decodeDiscovered = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment);

const discovered = (
  requestSuffix: string,
  patch: Partial<Record<"lifecycle" | "threadId" | "automationId", string | null>>,
) =>
  decodeDiscovered({
    requestId: `11111111-1111-4111-a111-${requestSuffix.padStart(12, "0")}`,
    leaseId: `lease-${requestSuffix}`,
    sandboxId: `sandbox-${requestSuffix}`,
    lifecycle: "active",
    environmentId: `env-${requestSuffix}`,
    provider: "e2b",
    label: "acme/app",
    repository: "acme/app",
    projectDir: "/workspace/app",
    threadId: `thread-${requestSuffix}`,
    automationId: "nightly",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2100-01-01T00:00:00.000Z",
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  });

function memoryStorage(seed?: Record<string, string>) {
  const records = new Map<string, string>(Object.entries(seed ?? {}));
  const storage: ProvisionStorage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      records.set(key, value);
    },
    removeItem: (key) => {
      records.delete(key);
    },
  };
  return { records, storage };
}

describe("automationEnvironmentsToJoin", () => {
  it("joins only new, active automation runs whose chat exists", () => {
    const { automationId: _, ...clientStarted } = discovered("1", {});
    const environments = [
      discovered("2", {}),
      clientStarted,
      discovered("3", { lifecycle: "paused" }),
      discovered("4", { threadId: null }),
      discovered("5", {}),
      discovered("6", {}),
    ];
    const selected = automationEnvironmentsToJoin(
      environments,
      new Set([EnvironmentId.make("env-5")]),
      new Set(["11111111-1111-4111-a111-000000000006"]),
    );
    expect(selected.map((environment) => environment.environmentId)).toEqual(["env-2"]);
  });
});

describe("createAutomationJoinAttempts", () => {
  it("remembers attempts across instances, keeps the newest 200, and moves a retry to the end", () => {
    const { records, storage } = memoryStorage();
    const attempts = createAutomationJoinAttempts(storage);
    for (let index = 0; index < 201; index += 1) attempts.record(`request-${index}`);
    attempts.record("request-5");
    const reloaded = createAutomationJoinAttempts(storage).attempted();
    expect([
      reloaded.has("request-0"),
      reloaded.has("request-1"),
      reloaded.has("request-200"),
    ]).toEqual([false, true, true]);
    const stored = JSON.parse(records.get(AUTOMATION_JOIN_ATTEMPTS_STORAGE_KEY)!);
    expect([stored.length, stored.at(-1), stored.indexOf("request-5")]).toEqual([
      200,
      "request-5",
      199,
    ]);
  });

  it("treats unreadable storage as no attempts", () => {
    const { storage } = memoryStorage({ [AUTOMATION_JOIN_ATTEMPTS_STORAGE_KEY]: "{" });
    expect([...createAutomationJoinAttempts(storage).attempted()]).toEqual([]);
  });
});
