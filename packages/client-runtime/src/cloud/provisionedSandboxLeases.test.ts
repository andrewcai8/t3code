import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createProvisionedSandboxLeaseStore,
  PROVISIONED_SANDBOX_LEASES_STORAGE_KEY,
} from "./provisionedSandboxLeases.ts";
import type { ProvisionStorage } from "./storage.ts";

const threadRef = { environmentId: EnvironmentId.make("child"), threadId: ThreadId.make("thread") };
const lease = {
  leaseId: "lease",
  sandboxId: "sandbox",
  managerEnvironmentId: EnvironmentId.make("manager"),
};

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

describe("provisioned sandbox leases", () => {
  it("persists a lease keyed by its owner and a reloaded store reads it back", () => {
    const { records, storage } = memoryStorage();
    createProvisionedSandboxLeaseStore(storage).remember("draft", lease);
    expect(JSON.parse(records.get(PROVISIONED_SANDBOX_LEASES_STORAGE_KEY)!)).toEqual({
      "draft:draft": { leaseId: "lease", sandboxId: "sandbox", managerEnvironmentId: "manager" },
    });
    expect(createProvisionedSandboxLeaseStore(storage).leaseFor("draft")).toEqual(lease);
  });

  it("moves a lease from the draft to the thread that started on it", () => {
    const store = createProvisionedSandboxLeaseStore(memoryStorage().storage);
    store.remember("draft", lease);
    expect(store.leaseForEnvironment(threadRef.environmentId)).toBeNull();
    store.transfer("draft", threadRef);
    expect(store.leaseFor("draft")).toBeNull();
    expect(store.leaseFor(threadRef)).toEqual(lease);
    expect(store.leaseForEnvironment(threadRef.environmentId)).toEqual({ lease, threadRef });
    store.forget(threadRef);
    expect(store.leaseForEnvironment(threadRef.environmentId)).toBeNull();
  });

  it("keeps a lease for an environment that has no thread yet and prefers the thread's once it does", () => {
    const { records, storage } = memoryStorage();
    const store = createProvisionedSandboxLeaseStore(storage);
    store.rememberForEnvironment(threadRef.environmentId, lease);
    expect(JSON.parse(records.get(PROVISIONED_SANDBOX_LEASES_STORAGE_KEY)!)).toEqual({
      "environment:child": {
        leaseId: "lease",
        sandboxId: "sandbox",
        managerEnvironmentId: "manager",
      },
    });
    const reloaded = createProvisionedSandboxLeaseStore(storage);
    expect(reloaded.leaseOwnedByEnvironment(threadRef.environmentId)).toEqual(lease);
    expect(reloaded.leaseForEnvironment(threadRef.environmentId)).toBeNull();
    expect(reloaded.leaseOwnedByEnvironment(EnvironmentId.make("other"))).toBeNull();

    const threadLease = { ...lease, leaseId: "thread-lease" };
    reloaded.remember(threadRef, threadLease);
    expect(reloaded.leaseOwnedByEnvironment(threadRef.environmentId)).toEqual(threadLease);
  });

  it("reads records written before leases had their own id", () => {
    const { storage } = memoryStorage({
      [PROVISIONED_SANDBOX_LEASES_STORAGE_KEY]: JSON.stringify({
        "thread:child:thread": { sandboxId: "sandbox", managerEnvironmentId: "manager" },
      }),
    });
    expect(createProvisionedSandboxLeaseStore(storage).leaseFor(threadRef)).toEqual({
      leaseId: "sandbox",
      sandboxId: "sandbox",
      managerEnvironmentId: "manager",
    });
  });

  it("discards a record it cannot decode", () => {
    const { records, storage } = memoryStorage({
      [PROVISIONED_SANDBOX_LEASES_STORAGE_KEY]: "not json",
    });
    expect(createProvisionedSandboxLeaseStore(storage).leaseFor("draft")).toBeNull();
    expect(records.has(PROVISIONED_SANDBOX_LEASES_STORAGE_KEY)).toBe(false);
  });
});

describe("boxes", () => {
  it("names only boxes their host reported, never an environment a thread key names", () => {
    const { storage } = memoryStorage();
    const store = createProvisionedSandboxLeaseStore(storage);
    store.remember("draft-still-provisioning", lease);
    // A lease a device moved to a thread on a real server by mistake names no box.
    store.remember(
      { environmentId: EnvironmentId.make("andrew-megpt-host"), threadId: ThreadId.make("t") },
      lease,
    );
    store.remember(threadRef, { ...lease, environmentId: EnvironmentId.make("reported-box") });
    store.rememberForEnvironment(EnvironmentId.make("joined"), {
      ...lease,
      managerEnvironmentId: EnvironmentId.make("other-host"),
    });
    expect(store.boxes()).toEqual([
      { environmentId: "reported-box", managerId: "manager" },
      { environmentId: "joined", managerId: "other-host" },
    ]);
  });
});

describe("reload", () => {
  it("reads leases persisted after the store was made, as once a phone's file is read", () => {
    const { records, storage } = memoryStorage();
    const store = createProvisionedSandboxLeaseStore(storage);
    records.set(
      PROVISIONED_SANDBOX_LEASES_STORAGE_KEY,
      JSON.stringify({ [`thread:${threadRef.environmentId}:${threadRef.threadId}`]: lease }),
    );
    expect(store.leaseFor(threadRef)).toBeNull();
    store.reload();
    expect(store.leaseFor(threadRef)).toEqual(lease);
  });
});
