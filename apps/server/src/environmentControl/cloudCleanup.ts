// @effect-diagnostics globalDate:off - cleanup times are ISO timestamps at the server boundary.
/**
 * When a paused cloud machine is removed, and the sweep that removes it. Only a Namespace Devbox
 * costs money while paused (its volume is billed by the GB-month), so only a lease with a
 * `namespaceResource` is ever planned. An E2B sandbox pauses for free, and an instance-engine
 * chat's snapshot expires on its own.
 *
 * @module cloudCleanup
 */
import type { OrchestrationThreadShell, ProvisionedCleanup } from "@t3tools/contracts";

import type { LeaseKeep, ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";
import type { WorkspaceBackup } from "./workspaceBackup.ts";

const DAY_MS = 86_400_000;
/** How long a settled chat's machine outlives its pause or its settle, whichever is later. */
const SETTLED_GRACE_MS = 3_600_000;
/** How long a lease whose cleanup failed outright waits before the sweep tries it again. */
const BACKUP_RETRY_MS = 6 * 3_600_000;

type CleanupThread = Pick<OrchestrationThreadShell, "id" | "settledOverride" | "settledAt">;
type CleanupLease = Pick<
  ProvisionedLease,
  "namespaceResource" | "keep" | "state" | "updatedAt" | "owner"
>;

/**
 * Null when the machine is never removed. A paused box never runs a turn, since a pause refuses a
 * busy box, and opening its chat wakes it, so the time it paused is when it was last in use. A
 * paused lease is not rewritten until it wakes, so `updatedAt` is that time. `thread` is the
 * host's kept card of the box's chat, and counts only while that chat still owns the box.
 */
export function cleanupPlan(input: {
  readonly lease: CleanupLease;
  readonly thread: CleanupThread | null;
  readonly afterDays: number | null;
}): ProvisionedCleanup | null {
  const { lease, thread, afterDays } = input;
  if (!lease.namespaceResource) return null;
  if (lease.keep && lease.state !== "disposed") return { kind: "kept", reason: lease.keep };
  if (lease.state !== "paused" || afterDays === null) return null;
  const pausedAt = Date.parse(lease.updatedAt);
  const idleAt = pausedAt + afterDays * DAY_MS;
  const settledAt =
    thread?.id === lease.owner?.threadId &&
    thread?.settledOverride === "settled" &&
    thread.settledAt !== null
      ? Math.max(pausedAt, Date.parse(thread.settledAt)) + SETTLED_GRACE_MS
      : Infinity;
  return settledAt < idleAt
    ? { kind: "scheduled", at: new Date(settledAt).toISOString(), reason: "settled" }
    : { kind: "scheduled", at: new Date(idleAt).toISOString(), reason: "idle" };
}

export interface CleanupCandidate {
  readonly lease: ProvisionedLease;
  readonly thread: CleanupThread | null;
}

export interface CleanupPorts {
  readonly now: () => number;
  /** The host's `cloudMachinesAfterDays`, read each pass and again right before each removal. */
  readonly afterDays: () => Promise<number | null>;
  /** Paused leases this host provisioned, each with its kept chat's thread. */
  readonly candidates: () => Promise<ReadonlyArray<CleanupCandidate>>;
  readonly read: (leaseId: string) => Promise<CleanupCandidate | null>;
  /** The per-box lock pause and resume take; null while another operation holds it. */
  readonly holdBox: (sandboxId: string) => Promise<(() => void) | null>;
  /** Marks the held box as being removed, so a resume no longer postpones its cleanup. */
  readonly beginRemoval: (sandboxId: string) => Promise<void> | void;
  /** Wakes the box and pushes its unsaved work. */
  readonly backUpWork: (lease: ProvisionedLease) => Promise<WorkspaceBackup>;
  readonly setKeep: (leaseId: string, keep: LeaseKeep | null) => Promise<unknown>;
  /** Puts a box the backup woke back to sleep. */
  readonly sleep: (lease: ProvisionedLease) => Promise<void>;
  /** Removes the machine and its lease; false when the removal is still pending. */
  readonly dispose: (leaseId: string) => Promise<boolean>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * The cleanup pass upkeep repeats: removes each paused machine whose cleanup time has passed, one
 * at a time, after pushing its unsaved work. Every machine a pass wakes ends it removed or asleep.
 * Only work the backup reports unpushable keeps a machine; a backup that fails outright is tried
 * again after `BACKUP_RETRY_MS`, and a failed sleep at the start of each later pass.
 */
export function createCleanupSweep(ports: CleanupPorts): () => Promise<void> {
  const retryAt = new Map<string, number>();
  const awake = new Map<string, ProvisionedLease>();
  const sleep = async (lease: ProvisionedLease) => {
    try {
      await ports.sleep(lease);
      awake.delete(lease.leaseId);
    } catch (cause) {
      awake.set(lease.leaseId, lease);
      ports.warn("cloud box could not be put back to sleep", { leaseId: lease.leaseId, cause });
    }
  };
  const due = (candidate: CleanupCandidate | null, afterDays: number | null) => {
    const plan = candidate && cleanupPlan({ ...candidate, afterDays });
    return plan?.kind === "scheduled" && Date.parse(plan.at) <= ports.now() ? plan : null;
  };

  return async () => {
    for (const [leaseId, lease] of awake) {
      const release = await ports.holdBox(lease.sandboxId);
      if (!release) continue;
      try {
        const current = await ports.read(leaseId);
        if (current?.lease.state === "paused") await sleep(current.lease);
        else awake.delete(leaseId);
      } catch (cause) {
        ports.warn("cloud box could not be put back to sleep", { leaseId, cause });
      } finally {
        release();
      }
    }

    const afterDays = await ports.afterDays();
    if (afterDays === null) return;
    for (const candidate of await ports.candidates()) {
      const { leaseId, sandboxId } = candidate.lease;
      if (!due(candidate, afterDays) || (retryAt.get(leaseId) ?? 0) > ports.now()) continue;
      const release = await ports.holdBox(sandboxId);
      if (!release) continue;
      let woken: ProvisionedLease | null = null;
      try {
        const current = await ports.read(leaseId);
        const plan = due(current, afterDays);
        if (!current || !plan) continue;
        woken = current.lease;
        const backup = await ports.backUpWork(current.lease);
        retryAt.delete(leaseId);
        if (backup.kind === "unsaved") {
          await ports.setKeep(leaseId, "unsaved-work");
          ports.warn("cloud box kept: its work could not be backed up", {
            leaseId,
            reason: backup.reason,
          });
          continue;
        }
        // Opening the chat or turning cleanup off while the backup ran makes it no longer due.
        await ports.beginRemoval(sandboxId);
        if (!due(await ports.read(leaseId), await ports.afterDays())) continue;
        if (!(await ports.dispose(leaseId))) {
          ports.warn("cloud box cleanup is still pending", { leaseId });
          continue;
        }
        woken = null;
        ports.log("cloud box cleaned up", {
          leaseId,
          reason: plan.reason,
          branches: backup.kind === "saved" ? backup.branches : [],
        });
      } catch (cause) {
        retryAt.set(leaseId, ports.now() + BACKUP_RETRY_MS);
        ports.warn("cloud box could not be cleaned up", { leaseId, cause });
      } finally {
        if (woken) await sleep(woken);
        release();
      }
    }
  };
}
