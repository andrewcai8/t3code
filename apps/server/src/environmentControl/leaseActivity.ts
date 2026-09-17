// @effect-diagnostics globalFetch:off - the manager reads a remote T3 server over private HTTP.
import { OrchestrationSession, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";

export type LeaseActivity = "busy" | "idle" | "unknown";

const decodeShell = Schema.decodeUnknownExit(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        archivedAt: OrchestrationThreadShell.fields.archivedAt,
        session: Schema.NullOr(Schema.Struct({ status: OrchestrationSession.fields.status })),
        hasPendingApprovals: OrchestrationThreadShell.fields.hasPendingApprovals,
        backgroundLiveness: OrchestrationThreadShell.fields.backgroundLiveness,
      }),
    ),
  }),
);

/**
 * Reads a remote T3 shell snapshot as whether its machine may be paused.
 * Pending user input and "monitoring" watch loops do not count, so a chat
 * waiting on a human cannot keep a machine awake forever.
 */
export function shellActivity(body: unknown): LeaseActivity {
  const shell = decodeShell(body);
  if (shell._tag === "Failure") return "unknown";
  return shell.value.threads.some(
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

export async function readLeaseActivity(lease: ProvisionedLease): Promise<LeaseActivity> {
  if (!lease.remoteAccess) return "unknown";
  try {
    const response = await fetch(`${lease.remoteAccess.origin}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${lease.remoteAccess.brokerToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "unknown";
    }
    return shellActivity(await response.json());
  } catch {
    return "unknown";
  }
}
