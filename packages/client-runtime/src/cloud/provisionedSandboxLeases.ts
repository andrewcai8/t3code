import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProvisionStorage } from "./storage.ts";

export interface ProvisionedSandboxLease {
  readonly leaseId: string;
  readonly sandboxId: string;
  readonly managerEnvironmentId: EnvironmentId;
  /** The box's environment as its host reported it; absent on leases recorded before. */
  readonly environmentId?: EnvironmentId;
}

export const PROVISIONED_SANDBOX_LEASES_STORAGE_KEY = "t3code:provisioned-sandbox-leases:v1";
const PersistedLease = Schema.Struct({
  leaseId: Schema.optional(Schema.String),
  sandboxId: Schema.String,
  managerEnvironmentId: Schema.String,
  environmentId: Schema.optional(Schema.String),
});
const PersistedLeases = Schema.Record(Schema.String, PersistedLease);
const decodePersistedLeases = Schema.decodeUnknownSync(PersistedLeases);

function key(target: string | ScopedThreadRef): string {
  return typeof target === "string"
    ? `draft:${target}`
    : `thread:${target.environmentId}:${target.threadId}`;
}

function environmentKey(environmentId: EnvironmentId): string {
  return `environment:${environmentId}`;
}

/**
 * Which sandbox a draft or thread owns, so the client can heartbeat, pause, and dispose it.
 * A lease starts under the draft that provisioned it and moves to the thread once the first
 * turn starts; whichever holds it is the one whose deletion must tear the machine down.
 * An environment joined from Settings before it has any thread is recorded under the
 * environment itself, which answers "is this a manager lease" but owns no lifecycle.
 */
export function createProvisionedSandboxLeaseStore(storage: ProvisionStorage) {
  const leases = new Map<string, ProvisionedSandboxLease>();

  function readPersisted(): void {
    const raw = storage.getItem(PROVISIONED_SANDBOX_LEASES_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = decodePersistedLeases(JSON.parse(raw));
      for (const [entryKey, value] of Object.entries(parsed)) {
        leases.set(entryKey, {
          leaseId: value.leaseId ?? value.sandboxId,
          sandboxId: value.sandboxId,
          managerEnvironmentId: EnvironmentId.make(value.managerEnvironmentId),
          ...(value.environmentId === undefined
            ? {}
            : { environmentId: EnvironmentId.make(value.environmentId) }),
        });
      }
    } catch {
      storage.removeItem(PROVISIONED_SANDBOX_LEASES_STORAGE_KEY);
    }
  }

  function persist(): void {
    storage.setItem(
      PROVISIONED_SANDBOX_LEASES_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(leases)),
    );
  }

  readPersisted();

  function remember(target: string | ScopedThreadRef, lease: ProvisionedSandboxLease): void {
    leases.set(key(target), lease);
    persist();
  }

  function rememberForEnvironment(
    environmentId: EnvironmentId,
    lease: ProvisionedSandboxLease,
  ): void {
    leases.set(environmentKey(environmentId), lease);
    persist();
  }

  function transfer(draftId: string, threadRef: ScopedThreadRef): void {
    const draftKey = key(draftId);
    const lease = leases.get(draftKey);
    if (!lease) return;
    leases.delete(draftKey);
    leases.set(key(threadRef), lease);
    persist();
  }

  /**
   * Moves the lease recorded under an environment to the thread whose first turn started there,
   * and returns it. Null when the environment holds none, so only the first turn claims the box.
   */
  function transferFromEnvironment(
    environmentId: EnvironmentId,
    threadRef: ScopedThreadRef,
  ): ProvisionedSandboxLease | null {
    const stored = leases.get(environmentKey(environmentId));
    if (!stored) return null;
    // The environment key is the id the box's host reported for it.
    const lease = { ...stored, environmentId: stored.environmentId ?? environmentId };
    leases.delete(environmentKey(environmentId));
    leases.set(key(threadRef), lease);
    persist();
    return lease;
  }

  function leaseFor(target: string | ScopedThreadRef): ProvisionedSandboxLease | null {
    return leases.get(key(target)) ?? null;
  }

  function leaseForEnvironment(environmentId: EnvironmentId) {
    const prefix = `thread:${environmentId}:`;
    for (const [entryKey, lease] of leases) {
      if (entryKey.startsWith(prefix))
        return {
          lease,
          threadRef: { environmentId, threadId: ThreadId.make(entryKey.slice(prefix.length)) },
        };
    }
    return null;
  }

  function leaseOwnedByEnvironment(environmentId: EnvironmentId): ProvisionedSandboxLease | null {
    return (
      leaseForEnvironment(environmentId)?.lease ?? leases.get(environmentKey(environmentId)) ?? null
    );
  }

  function forget(target: string | ScopedThreadRef): void {
    if (leases.delete(key(target))) persist();
  }

  /**
   * Reads the persisted leases again, for storage that fills after the store was made, as the
   * phone's does once its file is read.
   */
  function reload(): void {
    leases.clear();
    readPersisted();
  }

  /**
   * Each box this device holds a lease on, with the host that provisioned it. Only ids the box's
   * host reported count: those recorded on the lease, and a joined box's environment key. A
   * thread key's environment is only where this device sent a chat, which may be a real server.
   */
  function boxes(): ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly managerId: EnvironmentId;
  }> {
    return [...leases].flatMap(([entryKey, lease]) => {
      const environmentId =
        lease.environmentId ??
        (entryKey.startsWith("environment:")
          ? EnvironmentId.make(entryKey.slice("environment:".length))
          : null);
      return environmentId === null
        ? []
        : [{ environmentId, managerId: lease.managerEnvironmentId }];
    });
  }

  return {
    remember,
    rememberForEnvironment,
    transfer,
    transferFromEnvironment,
    leaseFor,
    leaseForEnvironment,
    leaseOwnedByEnvironment,
    forget,
    reload,
    boxes,
  };
}

export type ProvisionedSandboxLeaseStore = ReturnType<typeof createProvisionedSandboxLeaseStore>;
