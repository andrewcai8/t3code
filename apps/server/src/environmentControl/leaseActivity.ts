// @effect-diagnostics globalFetch:off globalTimers:off - the manager reads a remote T3 server over private HTTP, Promise-side.
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ThreadShell,
  type ProvisionedChat,
  UsageHistoryInput,
  UsageSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { leaseOwnedUsage, type BoxUsageStore } from "../usage/boxUsage.ts";
import {
  leaseAccounts,
  type ProvisionedLease,
  type RemoteAccess,
} from "./ProvisionedLeaseRegistry.ts";
import { ownerChat } from "./provisionedChats.ts";

export type LeaseActivity = "busy" | "idle" | "unknown";

/** What a host sends with every orchestration read or launch on one of its boxes. */
export const boxOrchestrationHeaders = (remote: RemoteAccess) => ({
  authorization: `Bearer ${remote.brokerToken}`,
  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
});

const decodeShell = Schema.decodeUnknownExit(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        archivedAt: Schema.NullOr(Schema.Unknown),
        status: OrchestrationV2ThreadShell.fields.status,
        activityRunStatus: OrchestrationV2ThreadShell.fields.activityRunStatus,
        pendingRuntimeRequest: Schema.NullOr(Schema.Struct({ kind: Schema.String })),
        pendingBackgroundTasks: Schema.optional(
          Schema.Array(Schema.Struct({ kind: Schema.String })),
        ),
      }),
    ),
  }),
);

/** A box still on a pre-V2 build answers with V1 threads; read them so it is never taken as idle. */
const decodeV1Shell = Schema.decodeUnknownExit(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        archivedAt: Schema.NullOr(Schema.Unknown),
        session: Schema.NullOr(
          Schema.Struct({
            status: Schema.Literals([
              "idle",
              "starting",
              "running",
              "ready",
              "interrupted",
              "stopped",
              "error",
            ]),
          }),
        ),
        hasPendingApprovals: Schema.Boolean,
        backgroundLiveness: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);

const RUN_IN_FLIGHT: ReadonlySet<string> = new Set(["preparing", "queued", "starting", "running"]);

/**
 * Reads a remote T3 shell snapshot as whether its machine may be paused.
 * A question for the user and "monitor" watch loops do not count, so a chat
 * waiting on a human cannot keep a machine awake forever.
 */
export function shellActivity(body: unknown): LeaseActivity {
  const shell = decodeShell(body);
  if (shell._tag === "Success")
    return shell.value.threads.some(
      (thread) =>
        thread.archivedAt === null &&
        (RUN_IN_FLIGHT.has(thread.status) ||
          RUN_IN_FLIGHT.has(thread.activityRunStatus ?? "") ||
          (thread.pendingRuntimeRequest !== null &&
            thread.pendingRuntimeRequest.kind !== "user_input") ||
          (thread.pendingBackgroundTasks ?? []).some((task) => task.kind !== "monitor")),
    )
      ? "busy"
      : "idle";
  const v1 = decodeV1Shell(body);
  if (v1._tag === "Failure") return "unknown";
  return v1.value.threads.some(
    (thread) =>
      thread.archivedAt === null &&
      (thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.hasPendingApprovals ||
        thread.backgroundLiveness === "working"),
  )
    ? "busy"
    : "idle";
}

export interface LeaseObservation {
  readonly activity: LeaseActivity;
  /** The owner's chat in the box's shell, as `ownerChat` reads it. Absent when unread. */
  readonly chat?: ProvisionedChat | null | undefined;
}

/** A box's shell snapshot, or null when the box cannot be read. */
export async function readLeaseShell(lease: ProvisionedLease): Promise<unknown> {
  if (!lease.remoteAccess) return null;
  try {
    const response = await fetch(`${lease.remoteAccess.origin}/api/orchestration/shell`, {
      headers: boxOrchestrationHeaders(lease.remoteAccess),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Reads a box's shell once, as its activity and its owner's chat. */
export async function observeLease(lease: ProvisionedLease): Promise<LeaseObservation> {
  const body = await readLeaseShell(lease);
  if (body === null) return { activity: "unknown" };
  return { activity: shellActivity(body), chat: readOwnerChat(lease, body) };
}

/** A chat that cannot be read leaves the previous one kept, and never hides a busy box. */
function readOwnerChat(lease: ProvisionedLease, body: unknown) {
  try {
    return lease.owner ? ownerChat(body, lease.owner.threadId) : null;
  } catch {
    return undefined;
  }
}

const decodeDescriptor = Schema.decodeUnknownExit(
  Schema.Struct({ orchestrationProtocolVersion: Schema.optional(Schema.Int) }),
);

/**
 * The orchestration protocol a box's T3 server speaks, from its public descriptor; a server that
 * predates the field speaks 1. Null when no attempt reads it: a just-started server may still be
 * coming up, so it is asked a few times.
 */
export async function readGuestProtocol(
  origin: string,
  attempts = 3,
  delayMs = 1_000,
): Promise<number | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${origin}/.well-known/t3/environment`, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const descriptor = decodeDescriptor(await response.json());
        if (descriptor._tag === "Success")
          return descriptor.value.orchestrationProtocolVersion ?? 1;
      } else await response.body?.cancel();
    } catch {
      // Retried below.
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Whether a resumed box must move onto the pinned build before a client connects. A box that
 * speaks this host's protocol is used on whatever build it runs, and upgraded later while idle.
 * One that cannot be read is upgraded only if it was asleep, since then nothing runs on it to cut.
 */
export function wakeNeedsUpgrade(guestProtocol: number | null, wasPaused: boolean): boolean {
  if (guestProtocol === null) return wasPaused;
  return guestProtocol !== ORCHESTRATION_PROTOCOL_VERSION;
}

const decodeUsageSummary = Schema.decodeUnknownSync(UsageSummary);
const encodeHistoryInput = Schema.encodeSync(Schema.fromJsonString(UsageHistoryInput));

/** Reads a remote T3 server's hourly usage since `sinceTime`, or throws. */
export async function readLeaseUsage(
  lease: ProvisionedLease,
  sinceTime: string,
  timeoutMs: number,
): Promise<UsageSummary> {
  if (!lease.remoteAccess) throw new Error("The cloud box has no remote access.");
  const response = await fetch(`${lease.remoteAccess.origin}/api/usage/history`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lease.remoteAccess.brokerToken}`,
      "content-type": "application/json",
    },
    body: encodeHistoryInput({ sinceTime }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The cloud box answered its usage history with status ${response.status}.`);
  }
  return decodeUsageSummary(await response.json());
}

/**
 * Pulls a box's usage and replaces what the host keeps for it. History starts
 * at the lease's creation because a forked box carries its parent's
 * transcripts, and records from before the fork belong to the parent.
 */
export const pullLeaseUsage = Effect.fn("pullLeaseUsage")(function* (
  store: BoxUsageStore["Service"],
  lease: ProvisionedLease,
  timeoutMs = 10_000,
) {
  const usage = yield* Effect.tryPromise(() => readLeaseUsage(lease, lease.createdAt, timeoutMs));
  yield* store.replace({
    leaseId: lease.leaseId,
    origin: "box",
    accountIds: leaseAccounts(lease),
    usage: leaseOwnedUsage(lease.leaseId, usage),
    pulledAt: DateTime.formatIso(yield* DateTime.now),
  });
});
