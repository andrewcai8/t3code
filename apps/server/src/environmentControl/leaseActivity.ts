// @effect-diagnostics globalFetch:off - the manager reads a remote T3 server over private HTTP.
import {
  ORCHESTRATION_PROTOCOL_HEADER,
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
import type { ProvisionedLease, RemoteAccess } from "./ProvisionedLeaseRegistry.ts";
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

/** Reads a box's shell once, as its activity and its owner's chat. */
export async function observeLease(lease: ProvisionedLease): Promise<LeaseObservation> {
  if (!lease.remoteAccess) return { activity: "unknown" };
  try {
    const response = await fetch(`${lease.remoteAccess.origin}/api/orchestration/shell`, {
      headers: boxOrchestrationHeaders(lease.remoteAccess),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { activity: "unknown" };
    }
    const body: unknown = await response.json();
    return { activity: shellActivity(body), chat: readOwnerChat(lease, body) };
  } catch {
    return { activity: "unknown" };
  }
}

/** A chat that cannot be read leaves the previous one kept, and never hides a busy box. */
function readOwnerChat(lease: ProvisionedLease, body: unknown) {
  try {
    return lease.owner ? ownerChat(body, lease.owner.threadId) : null;
  } catch {
    return undefined;
  }
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
    accountIds: [lease.providerInstanceId, ...(lease.companionInstanceIds ?? [])],
    usage: leaseOwnedUsage(lease.leaseId, usage),
    pulledAt: DateTime.formatIso(yield* DateTime.now),
  });
});
