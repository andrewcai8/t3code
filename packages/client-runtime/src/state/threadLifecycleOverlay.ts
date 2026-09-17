import {
  EnvironmentId,
  ThreadId,
  type OrchestrationThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { ConnectionBlockedError } from "../connection/model.ts";

import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { environmentAllowsThreadSettlement } from "./threadSettled.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isConnectionBlocked = Schema.is(ConnectionBlockedError);

function isEnvironmentNotRegistered(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag: unknown })._tag === "EnvironmentNotRegisteredError"
  );
}

/** Park, restore, or delete a thread while its environment has no live RPC session. */
export type ThreadLifecycleOverlayKind = "settled" | "unsettled" | "deleted";

export interface ThreadLifecycleOverlay {
  readonly kind: ThreadLifecycleOverlayKind;
  readonly at: string;
}

const EMPTY_THREAD_LIFECYCLE_OVERLAYS: ReadonlyMap<string, ThreadLifecycleOverlay> = new Map();

const THREAD_LIFECYCLE_OVERLAY_STORAGE_KEY = "t3code:thread-lifecycle-overlay:v1";

export const threadLifecycleOverlayAtom = Atom.make<ReadonlyMap<string, ThreadLifecycleOverlay>>(
  hydrateThreadLifecycleOverlays(),
).pipe(Atom.keepAlive, Atom.withLabel("thread-lifecycle-overlay"));

const OFFLINE_DISPATCH_SEQUENCE = 0;

export const OFFLINE_THREAD_LIFECYCLE_DISPATCH_RESULT = {
  sequence: OFFLINE_DISPATCH_SEQUENCE,
  offline: true as const,
};

export function isOfflineThreadLifecycleDispatchResult(
  value: unknown,
): value is typeof OFFLINE_THREAD_LIFECYCLE_DISPATCH_RESULT {
  return (
    typeof value === "object" &&
    value !== null &&
    "offline" in value &&
    (value as { offline: unknown }).offline === true
  );
}

export function threadLifecycleOverlaysEqual(
  left: ThreadLifecycleOverlay | undefined,
  right: ThreadLifecycleOverlay | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.kind === right.kind && left.at === right.at;
}

export function applyThreadLifecycleOverlay<
  T extends Pick<
    OrchestrationThreadShell,
    "settledOverride" | "settledAt" | "unsettledAt" | "activeOrderKey"
  >,
>(thread: T, overlay: ThreadLifecycleOverlay | undefined): T {
  // A deleted thread is dropped from the lists instead; see withoutDeletedThreads.
  if (overlay === undefined || overlay.kind === "deleted") return thread;
  if (overlay.kind === "settled") {
    if (
      thread.settledOverride === "settled" &&
      thread.settledAt === overlay.at &&
      thread.unsettledAt === null &&
      thread.activeOrderKey === null
    ) {
      return thread;
    }
    return {
      ...thread,
      settledOverride: "settled",
      settledAt: overlay.at,
      unsettledAt: null,
      activeOrderKey: null,
    };
  }
  if (thread.settledOverride === "active" && thread.settledAt === null) {
    return thread.unsettledAt === overlay.at ? thread : { ...thread, unsettledAt: overlay.at };
  }
  return {
    ...thread,
    settledOverride: "active",
    settledAt: null,
    unsettledAt: overlay.at,
  };
}

/** Drop threads deleted on this device from one environment's thread list. */
export function withoutDeletedThreads<T extends { readonly id: ThreadId }>(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<T>,
  overlays: ReadonlyMap<string, ThreadLifecycleOverlay>,
): ReadonlyArray<T> {
  let deleted: Set<ThreadId> | undefined;
  for (const [key, overlay] of overlays) {
    if (overlay.kind !== "deleted") continue;
    const ref = parseThreadKey(key);
    if (ref.environmentId === environmentId) (deleted ??= new Set()).add(ref.threadId);
  }
  return deleted === undefined ? threads : threads.filter((thread) => !deleted.has(thread.id));
}

export function isThreadLifecycleOfflineFailure(error: unknown): boolean {
  if (isEnvironmentRpcUnavailable(error)) return true;
  if (isConnectionBlocked(error) && error.reason === "workspace-missing") return true;
  if (isEnvironmentNotRegistered(error)) return true;
  if (isRpcClientError(error) && isTransportConnectionErrorMessage(error.message)) return true;
  const message = errorMessage(error);
  return message !== undefined && isTransportConnectionErrorMessage(message);
}

export function setThreadLifecycleOverlay(
  registry: AtomRegistry.AtomRegistry,
  ref: ScopedThreadRef,
  overlay: ThreadLifecycleOverlay | undefined,
): void {
  const key = threadKey(ref);
  const current = registry.get(threadLifecycleOverlayAtom);
  const existing = current.get(key);
  if (overlay === undefined) {
    if (existing === undefined) return;
    const next = new Map(current);
    next.delete(key);
    registry.set(threadLifecycleOverlayAtom, next);
    return;
  }
  if (threadLifecycleOverlaysEqual(existing, overlay)) return;
  const next = new Map(current);
  next.set(key, overlay);
  registry.set(threadLifecycleOverlayAtom, next);
}

export function replaceThreadLifecycleOverlays(
  registry: AtomRegistry.AtomRegistry,
  overlays: ReadonlyMap<string, ThreadLifecycleOverlay>,
): void {
  const current = registry.get(threadLifecycleOverlayAtom);
  if (lifecycleOverlayMapsEqual(current, overlays)) return;
  registry.set(threadLifecycleOverlayAtom, overlays);
}

export function queueOfflineThreadLifecycleOverlay(
  registry: AtomRegistry.AtomRegistry,
  ref: ScopedThreadRef,
  kind: ThreadLifecycleOverlayKind,
  at: string = new Date().toISOString(),
): void {
  const existing = registry.get(threadLifecycleOverlayAtom).get(threadKey(ref));
  // A pending delete outranks settlement: the thread is gone from this device.
  if (existing?.kind === "deleted" && kind !== "deleted") return;
  if (kind === "unsettled") {
    // A pending settle never reached the server: dropping it restores the
    // cached shell instead of leaving a local un-settle that would flush.
    if (existing?.kind === "settled") {
      setThreadLifecycleOverlay(registry, ref, undefined);
      return;
    }
  }
  // Keep the original timestamp so a reconnect flush cannot churn the atom.
  if (existing?.kind === kind) return;
  setThreadLifecycleOverlay(registry, ref, { kind, at });
}

export interface ThreadLifecycleOverlayFlushJob {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly kind: ThreadLifecycleOverlayKind;
}

/**
 * Overlays that can be dispatched now that the environment is connected.
 * A delete needs no settlement support, only a connection.
 */
export function pendingThreadLifecycleFlushJobs(
  overlays: ReadonlyMap<string, ThreadLifecycleOverlay>,
  environments: {
    readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly liveCapableEnvironmentIds: ReadonlySet<EnvironmentId>;
  },
): ReadonlyArray<ThreadLifecycleOverlayFlushJob> {
  const jobs: ThreadLifecycleOverlayFlushJob[] = [];
  for (const [key, overlay] of overlays) {
    const ref = parseThreadKey(key);
    const ready =
      overlay.kind === "deleted"
        ? environments.liveEnvironmentIds
        : environments.liveCapableEnvironmentIds;
    if (!ready.has(ref.environmentId)) continue;
    jobs.push({
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      kind: overlay.kind,
    });
  }
  return jobs;
}

export interface ThreadLifecycleOverlayEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly live: boolean;
  readonly capabilities: { readonly threadSettlement?: boolean } | undefined;
  readonly snapshot: {
    readonly threads: ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "settledOverride">>;
  } | null;
}

/** Reconcile confirmed overlays, then return the commands still waiting on reconnect. */
export function planThreadLifecycleOverlaySync(input: {
  readonly overlays: ReadonlyMap<string, ThreadLifecycleOverlay>;
  readonly environments: ReadonlyArray<ThreadLifecycleOverlayEnvironmentState>;
}): {
  readonly overlays: ReadonlyMap<string, ThreadLifecycleOverlay>;
  readonly jobs: ReadonlyArray<ThreadLifecycleOverlayFlushJob>;
} {
  const liveEnvironmentIds = new Set<EnvironmentId>();
  const liveCapableEnvironmentIds = new Set<EnvironmentId>();
  const liveIncapableEnvironmentIds = new Set<EnvironmentId>();
  const rawThreadsByKey = new Map<string, Pick<OrchestrationThreadShell, "settledOverride">>();
  for (const environment of input.environments) {
    const allows = environmentAllowsThreadSettlement(environment.capabilities);
    if (environment.live) liveEnvironmentIds.add(environment.environmentId);
    if (environment.live && environment.capabilities?.threadSettlement === true) {
      liveCapableEnvironmentIds.add(environment.environmentId);
    }
    if (environment.live && environment.capabilities !== undefined && !allows) {
      liveIncapableEnvironmentIds.add(environment.environmentId);
    }
    if (environment.snapshot === null) continue;
    for (const thread of environment.snapshot.threads) {
      rawThreadsByKey.set(
        threadKey({ environmentId: environment.environmentId, threadId: thread.id }),
        thread,
      );
    }
  }
  const overlays = reconcileThreadLifecycleOverlays(input.overlays, {
    rawThreadsByKey,
    liveCapableEnvironmentIds,
    liveIncapableEnvironmentIds,
  });
  return {
    overlays,
    jobs: pendingThreadLifecycleFlushJobs(overlays, {
      liveEnvironmentIds,
      liveCapableEnvironmentIds,
    }),
  };
}

/**
 * Drop settle overlays the live snapshot has confirmed, and those that cannot
 * be flushed because this server predates settlement. A delete overlay stays
 * until its replay settles: archived threads are absent from the snapshot too,
 * so absence cannot confirm a delete.
 */
export function reconcileThreadLifecycleOverlays(
  overlays: ReadonlyMap<string, ThreadLifecycleOverlay>,
  input: {
    readonly rawThreadsByKey: ReadonlyMap<
      string,
      Pick<OrchestrationThreadShell, "settledOverride">
    >;
    readonly liveCapableEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly liveIncapableEnvironmentIds: ReadonlySet<EnvironmentId>;
  },
): ReadonlyMap<string, ThreadLifecycleOverlay> {
  if (overlays.size === 0) return overlays;
  let changed = false;
  const next = new Map(overlays);
  for (const [key, overlay] of overlays) {
    if (overlay.kind === "deleted") continue;
    const environmentId = parseThreadKey(key).environmentId;
    if (input.liveIncapableEnvironmentIds.has(environmentId)) {
      next.delete(key);
      changed = true;
      continue;
    }
    if (!input.liveCapableEnvironmentIds.has(environmentId)) continue;
    const raw = input.rawThreadsByKey.get(key);
    if (raw === undefined) continue;
    const confirmed =
      overlay.kind === "settled"
        ? raw.settledOverride === "settled"
        : raw.settledOverride !== "settled";
    if (!confirmed) continue;
    next.delete(key);
    changed = true;
  }
  return changed ? next : overlays;
}

export function persistThreadLifecycleOverlays(
  overlays: ReadonlyMap<string, ThreadLifecycleOverlay>,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (overlays.size === 0) {
      localStorage.removeItem(THREAD_LIFECYCLE_OVERLAY_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      THREAD_LIFECYCLE_OVERLAY_STORAGE_KEY,
      encodeThreadLifecycleOverlays(overlays),
    );
  } catch {
    // Quota and private-mode failures must not block settle.
  }
}

function hydrateThreadLifecycleOverlays(): ReadonlyMap<string, ThreadLifecycleOverlay> {
  if (typeof localStorage === "undefined") return EMPTY_THREAD_LIFECYCLE_OVERLAYS;
  try {
    const raw = localStorage.getItem(THREAD_LIFECYCLE_OVERLAY_STORAGE_KEY);
    return raw === null ? EMPTY_THREAD_LIFECYCLE_OVERLAYS : decodeThreadLifecycleOverlays(raw);
  } catch {
    return EMPTY_THREAD_LIFECYCLE_OVERLAYS;
  }
}

export function encodeThreadLifecycleOverlays(
  overlays: ReadonlyMap<string, ThreadLifecycleOverlay>,
): string {
  const entries: PersistedThreadLifecycleOverlay[] = [];
  for (const [key, overlay] of overlays) {
    const ref = parseThreadKey(key);
    entries.push({
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      kind: overlay.kind,
      at: overlay.at,
    });
  }
  return JSON.stringify(entries);
}

export function decodeThreadLifecycleOverlays(
  raw: string,
): ReadonlyMap<string, ThreadLifecycleOverlay> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return EMPTY_THREAD_LIFECYCLE_OVERLAYS;
  const overlays = new Map<string, ThreadLifecycleOverlay>();
  for (const entry of parsed) {
    const overlay = decodePersistedOverlay(entry);
    if (overlay === null) continue;
    overlays.set(threadKey(overlay.ref), { kind: overlay.kind, at: overlay.at });
  }
  return overlays.size === 0 ? EMPTY_THREAD_LIFECYCLE_OVERLAYS : overlays;
}

interface PersistedThreadLifecycleOverlay {
  readonly environmentId: string;
  readonly threadId: string;
  readonly kind: ThreadLifecycleOverlayKind;
  readonly at: string;
}

function decodePersistedOverlay(entry: unknown): {
  readonly ref: ScopedThreadRef;
  readonly kind: ThreadLifecycleOverlayKind;
  readonly at: string;
} | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Partial<PersistedThreadLifecycleOverlay>;
  if (
    typeof record.environmentId !== "string" ||
    record.environmentId.length === 0 ||
    typeof record.threadId !== "string" ||
    record.threadId.length === 0 ||
    (record.kind !== "settled" && record.kind !== "unsettled" && record.kind !== "deleted") ||
    typeof record.at !== "string" ||
    !Number.isFinite(Date.parse(record.at))
  ) {
    return null;
  }
  return {
    ref: {
      environmentId: EnvironmentId.make(record.environmentId),
      threadId: ThreadId.make(record.threadId),
    },
    kind: record.kind,
    at: record.at,
  };
}

function lifecycleOverlayMapsEqual(
  left: ReadonlyMap<string, ThreadLifecycleOverlay>,
  right: ReadonlyMap<string, ThreadLifecycleOverlay>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, overlay] of left) {
    if (!threadLifecycleOverlaysEqual(overlay, right.get(key))) return false;
  }
  return true;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
}
