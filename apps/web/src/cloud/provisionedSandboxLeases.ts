import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ProvisionedSandboxLease {
  readonly leaseId: string;
  readonly sandboxId: string;
  readonly managerEnvironmentId: EnvironmentId;
}

const STORAGE_KEY = "t3code:provisioned-sandbox-leases:v1";
const PersistedLease = Schema.Struct({
  leaseId: Schema.optional(Schema.String),
  sandboxId: Schema.String,
  managerEnvironmentId: Schema.String,
});
const PersistedLeases = Schema.Record(Schema.String, PersistedLease);
const decodePersistedLeases = Schema.decodeUnknownSync(PersistedLeases);
const leases = new Map<string, ProvisionedSandboxLease>();

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function key(target: string | ScopedThreadRef): string {
  return typeof target === "string"
    ? `draft:${target}`
    : `thread:${target.environmentId}:${target.threadId}`;
}

function readPersisted(): void {
  const raw = storage()?.getItem(STORAGE_KEY);
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
    storage()?.removeItem(STORAGE_KEY);
  }
}

function persist(): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(leases)));
}

readPersisted();

export function rememberProvisionedSandbox(
  target: string | ScopedThreadRef,
  lease: ProvisionedSandboxLease,
): void {
  leases.set(key(target), lease);
  persist();
}

export function transferProvisionedSandboxLease(draftId: string, threadRef: ScopedThreadRef): void {
  const draftKey = key(draftId);
  const lease = leases.get(draftKey);
  if (!lease) return;
  leases.delete(draftKey);
  leases.set(key(threadRef), lease);
  persist();
}

export function provisionedSandboxFor(
  target: string | ScopedThreadRef,
): ProvisionedSandboxLease | null {
  return leases.get(key(target)) ?? null;
}

export function allProvisionedSandboxes(): ReadonlyArray<ProvisionedSandboxLease> {
  return [...leases.values()];
}

export function provisionedSandboxForEnvironment(environmentId: EnvironmentId) {
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

export function forgetProvisionedSandbox(target: string | ScopedThreadRef): void {
  if (leases.delete(key(target))) persist();
}
