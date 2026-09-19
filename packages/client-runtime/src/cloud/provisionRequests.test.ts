import {
  EnvironmentId,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createProvisionRequestStore,
  PROVISION_IN_PROGRESS_MESSAGE,
  PROVISION_REQUESTS_STORAGE_KEY,
} from "./provisionRequests.ts";
import type { ProvisionStorage } from "./storage.ts";

const request = {
  managerEnvironmentId: EnvironmentId.make("manager"),
  input: {
    provider: "e2b",
    providerInstanceId: "codex-account",
    agentDriver: ProviderDriverKind.make("codex"),
    repository: "example/repository",
  } satisfies Omit<EnvironmentProvisionInput, "requestId">,
};

function memoryStorage() {
  const records = new Map<string, string>();
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

function uuidSequence() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

/** The store's clock: retries wait here until the test fires them, so nothing depends on real time. */
function manualScheduler() {
  const pending = new Set<() => void>();
  return {
    pending,
    schedule: (callback: () => void) => {
      pending.add(callback);
      return () => {
        pending.delete(callback);
      };
    },
    /** Yields until the store has scheduled its next retry. */
    async untilScheduled() {
      for (let tick = 0; pending.size === 0 && tick < 1_000; tick++) await Promise.resolve();
    },
    /** Fires every retry as soon as it is scheduled until `outcome` settles. */
    async runUntil(outcome: Promise<unknown>) {
      const done = outcome.then(
        () => "done" as const,
        () => "done" as const,
      );
      for (let tick = 0; tick < 10_000; tick++) {
        for (const callback of pending) {
          pending.delete(callback);
          callback();
        }
        if ((await Promise.race([done, Promise.resolve("tick" as const)])) === "done") return;
      }
    },
  };
}

function createStore(
  storage: ProvisionStorage,
  options: {
    readonly randomUUID?: () => string;
    readonly scheduler?: ReturnType<typeof manualScheduler>;
  } = {},
) {
  return createProvisionRequestStore({
    storage,
    randomUUID: options.randomUUID ?? uuidSequence(),
    schedule: (options.scheduler ?? manualScheduler()).schedule,
  });
}

function readyResult(
  requestId: EnvironmentProvisionInput["requestId"],
): EnvironmentProvisionResult {
  return {
    kind: "ready",
    requestId,
    environment: {
      environmentId: EnvironmentId.make("prepared"),
      leaseId: "lease",
      provider: "e2b",
      sandboxId: "sandbox",
      projectDir: "/workspace",
      providerInstanceId: "codex-account",
      sourceRevision: null,
      t3Revision: "a".repeat(40),
      artifactSha256: "b".repeat(64),
      control: {
        preparationRoot: "/prepared",
        brokerCredentialPath: "/prepared/credential",
        localT3Url: "http://localhost:3773",
        runtimeExecutable: "node",
        runtimeEntrypoint: "/prepared/t3/index.mjs",
      },
    },
  };
}

describe("draft provisioning requests", () => {
  it("persists the request before dispatch and a reloaded store recovers the exact input", () => {
    const { records, storage } = memoryStorage();
    const randomUUID = uuidSequence();
    const first = createStore(storage, { randomUUID }).reserve("draft-1", request);
    expect(first).toEqual({
      managerEnvironmentId: "manager",
      input: { ...request.input, requestId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(JSON.parse(records.get(PROVISION_REQUESTS_STORAGE_KEY)!)).toEqual({
      "draft-1": first,
    });
    const reloaded = createStore(storage, { randomUUID });
    expect(reloaded.reserve("draft-1", request)).toEqual(first);
    expect(reloaded.reserve("draft-2", request).input.requestId).not.toBe(first.input.requestId);
  });

  it("refuses changed intent while preserving the original pending request", () => {
    const store = createStore(memoryStorage().storage);
    const first = store.reserve("draft-1", request);
    expect(() =>
      store.reserve("draft-1", {
        ...request,
        input: { ...request.input, providerInstanceId: "another-account" },
      }),
    ).toThrow("already requested an environment");
    expect(store.reserve("draft-1", request)).toEqual(first);
  });

  it("does not return an allocatable request if persistence fails", () => {
    const store = createStore({
      ...memoryStorage().storage,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    });
    expect(() => store.reserve("draft-1", request)).toThrow("storage unavailable");
  });

  it("forgets a submitted draft without changing another draft's retry identity", () => {
    const { records, storage } = memoryStorage();
    const store = createStore(storage);
    store.reserve("draft-1", request);
    const other = store.reserve("draft-2", request);
    expect(store.forget("draft-1")).toBe(true);
    expect(JSON.parse(records.get(PROVISION_REQUESTS_STORAGE_KEY)!)).toEqual({
      "draft-2": other,
    });
    expect(store.reserve("draft-2", request)).toEqual(other);
  });

  it("keeps a completed send successful when request cleanup cannot be persisted", () => {
    const { storage } = memoryStorage();
    let writable = true;
    const store = createStore({
      ...storage,
      setItem: (key, value) => {
        if (!writable) throw new Error("storage unavailable");
        storage.setItem(key, value);
      },
    });
    const first = store.reserve("draft-1", request);
    writable = false;
    expect(store.forget("draft-1")).toBe(false);
    expect(store.reserve("draft-1", request)).toEqual(first);
  });
});

describe("provision request polling and cancellation", () => {
  it("polls pending, ambiguous and transient responses with the exact saved request", async () => {
    const scheduler = manualScheduler();
    const store = createStore(memoryStorage().storage, { scheduler });
    const saved = store.reserve("polling-draft", request);
    const results: Array<EnvironmentProvisionResult | null> = [
      { kind: "pending", requestId: saved.input.requestId, message: PROVISION_IN_PROGRESS_MESSAGE },
      {
        kind: "allocation_unknown",
        requestId: saved.input.requestId,
        message: "Checking allocation",
      },
      null,
      readyResult(saved.input.requestId),
    ];
    const dispatch = vi.fn<(input: typeof saved) => Promise<EnvironmentProvisionResult | null>>(
      async () => results.shift() ?? null,
    );
    const result = store.poll("polling-draft", saved, dispatch);
    await scheduler.runUntil(result);
    expect(await result).toEqual(readyResult(saved.input.requestId));
    expect(dispatch.mock.calls).toHaveLength(4);
    for (const [input] of dispatch.mock.calls) expect(input).toEqual(saved);
    expect(store.reserve("polling-draft", request)).toEqual(saved);
  });

  it("bounds automatic polling and leaves the same request available for resume", async () => {
    const scheduler = manualScheduler();
    const store = createStore(memoryStorage().storage, { scheduler });
    const saved = store.reserve("bounded-draft", request);
    const dispatch = vi.fn(async () => null);
    const result = store.poll("bounded-draft", saved, dispatch);
    await scheduler.runUntil(result);
    expect(await result).toEqual({ kind: "unreachable" });
    expect(dispatch).toHaveBeenCalledTimes(60);
    expect(store.reserve("bounded-draft", request)).toEqual(saved);
  });

  it("stops polling when preparation reports a lastError instead of retrying for minutes", async () => {
    const store = createStore(memoryStorage().storage);
    const saved = store.reserve("failed-draft", request);
    const dispatch = vi.fn(async () => ({
      kind: "pending" as const,
      requestId: saved.input.requestId,
      message: "Remote preparation failed: Preparation command timed out: git fetch",
    }));
    await expect(store.poll("failed-draft", saved, dispatch)).resolves.toEqual({
      kind: "pending",
      requestId: saved.input.requestId,
      message: "Remote preparation failed: Preparation command timed out: git fetch",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.reserve("failed-draft", request)).toEqual(saved);
  });

  it("stops waiting immediately when the draft is cancelled", async () => {
    const scheduler = manualScheduler();
    const store = createStore(memoryStorage().storage, { scheduler });
    const saved = store.reserve("waiting-draft", request);
    const dispatch = vi.fn(async () => ({
      kind: "pending" as const,
      requestId: saved.input.requestId,
      message: PROVISION_IN_PROGRESS_MESSAGE,
    }));
    const result = store.poll("waiting-draft", saved, dispatch);
    await scheduler.untilScheduled();
    expect(scheduler.pending.size).toBe(1);
    store.cancel("waiting-draft");
    expect(await result).toEqual({ kind: "cancelled" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(scheduler.pending.size).toBe(0);
  });

  it("ignores a receipt arriving after deletion and retains cancellation until disposal is confirmed", async () => {
    const { records, storage } = memoryStorage();
    const store = createStore(storage);
    const saved = store.reserve("cancelled-draft", request);
    let release: (value: EnvironmentProvisionResult) => void = () => {
      throw new Error("Receipt barrier not initialized");
    };
    const receipt = new Promise<EnvironmentProvisionResult>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(() => receipt);
    const result = store.poll("cancelled-draft", saved, dispatch);
    store.cancel("cancelled-draft");
    release(readyResult(saved.input.requestId));
    expect(await result).toEqual({ kind: "cancelled" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const observed: Array<unknown> = [];
    expect(
      await store.drainCancellations(async (pending) => {
        observed.push({
          manager: pending.managerEnvironmentId,
          requestId: pending.input.requestId,
        });
        return { kind: "refused", reason: "unknown", message: "Allocation still unknown" };
      }),
    ).toEqual([]);
    expect(
      await store.drainCancellations(async (pending) => {
        observed.push({
          manager: pending.managerEnvironmentId,
          requestId: pending.input.requestId,
        });
        return { kind: "disposed" };
      }),
    ).toEqual(["cancelled-draft"]);
    expect(observed).toEqual([
      { manager: "manager", requestId: saved.input.requestId },
      { manager: "manager", requestId: saved.input.requestId },
    ]);
    expect([...records.values()].map((value) => JSON.parse(value))).toEqual([{}]);
  });

  it("starts a fresh request after cancel while disposing the cancelled one", async () => {
    const store = createStore(memoryStorage().storage);
    const saved = store.reserve("retry-draft", request);
    store.cancel("retry-draft");
    const retried = store.reserve("retry-draft", request);
    expect(retried.input.requestId).not.toBe(saved.input.requestId);
    expect(store.isActive("retry-draft")).toBe(true);
    const observed: string[] = [];
    expect(
      await store.drainCancellations(async (pending) => {
        observed.push(pending.input.requestId);
        return { kind: "disposed" };
      }),
    ).toEqual([]);
    expect(observed).toEqual([saved.input.requestId]);
    expect(store.isActive("retry-draft")).toBe(true);
    expect(store.reserve("retry-draft", request)).toEqual(retried);
  });

  it("abandons an in-flight poll when a later send replaces the cancelled request", async () => {
    const store = createStore(memoryStorage().storage);
    const saved = store.reserve("replaced-draft", request);
    let release: (value: EnvironmentProvisionResult) => void = () => {
      throw new Error("Receipt barrier not initialized");
    };
    const receipt = new Promise<EnvironmentProvisionResult>((resolve) => {
      release = resolve;
    });
    const result = store.poll("replaced-draft", saved, () => receipt);
    store.cancel("replaced-draft");
    const retried = store.reserve("replaced-draft", request);
    release(readyResult(saved.input.requestId));
    expect(await result).toEqual({ kind: "cancelled" });
    expect(retried.input.requestId).not.toBe(saved.input.requestId);
  });
});
