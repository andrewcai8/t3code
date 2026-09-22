import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProvisionStorage } from "./storage.ts";

export interface ProvisionedSandboxLease {
  readonly leaseId: string;
  readonly sandboxId: string;
  readonly managerEnvironmentId: EnvironmentId;
}

export const PROVISIONED_SANDBOX_LEASES_STORAGE_KEY = "t3code:provisioned-sandbox-leases:v1";
const PersistedLease = Schema.Struct({
  leaseId: Schema.optional(Schema.String),
  sandboxId: Schema.String,
  managerEnvironmentId: Schema.String,
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

  return {
    remember,
    rememberForEnvironment,
    transfer,
    leaseFor,
    leaseForEnvironment,
    leaseOwnedByEnvironment,
    forget,
  };
}

export type ProvisionedSandboxLeaseStore = ReturnType<typeof createProvisionedSandboxLeaseStore>;
