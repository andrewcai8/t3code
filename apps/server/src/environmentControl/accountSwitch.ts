// @effect-diagnostics globalFetch:off globalDate:off - the host calls its boxes over private HTTP, Promise-side.
/**
 * Moving a cloud machine onto another account of the provider one of its chats runs on, from the
 * host that provisioned it. The box keeps its conversation, files and processes; only the chat's
 * provider session restarts, on the new login, and resumes where it stopped.
 *
 * @module environmentControl/accountSwitch
 */
import {
  defaultInstanceIdForDriver,
  type EnvironmentProvisionSwitchAccountResult,
  type GuestAccountCredential,
  GuestAccountSwitchInput,
  GuestAccountSwitchResult,
  type ProvisionedChat,
  ProviderDriverKind,
  SwitchableAccountDriver,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  leaseAccounts,
  type AccountLimit,
  type ProvisionedLease,
  type ProvisionedLeaseRegistry,
  type RemoteAccess,
} from "./ProvisionedLeaseRegistry.ts";
import { ownerChat } from "./provisionedChats.ts";

/** An account a box can move to: the host's instance, and the login the box is handed. */
export interface SwitchTarget {
  readonly instanceId: string;
  /** The host's name for the account, as a client shows it. */
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly accountEmail?: string | undefined;
  readonly credential: GuestAccountCredential;
}

export interface AccountSwitchPorts {
  /** The box's shell snapshot, or null when it cannot be read. */
  readonly readShell: (lease: ProvisionedLease) => Promise<unknown>;
  /** The driver of one of this host's accounts; undefined for an account it no longer has. */
  readonly accountDriver: (instanceId: string) => Promise<string | undefined>;
  /** The best account of the driver outside `exclude` that can run in the cloud, or null. */
  readonly pickAccount: (
    driver: SwitchableAccountDriver,
    exclude: ReadonlySet<string>,
  ) => Promise<SwitchTarget | null>;
  /** Hands the box the new login. `missing` when the box's build predates account switching. */
  readonly sendSwitch: (
    lease: ProvisionedLease,
    input: GuestAccountSwitchInput,
  ) => Promise<GuestAccountSwitchResult | "missing">;
}

/** Statuses of a chat whose turn has started. A queued one has not, and switches. */
const RUN_IN_FLIGHT: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);
/** How long an account that hit a limit without naming its reset is kept out of rotation. */
const UNKNOWN_RESET_MS = 5 * 3_600_000;

type Thread = ProvisionedChat["thread"];

/** The driver of a box's provider instance, when it is one whose account a host can switch. */
const switchableDriver = (instanceId: string) =>
  SwitchableAccountDriver.literals.find(
    (driver) => defaultInstanceIdForDriver(ProviderDriverKind.make(driver)) === instanceId,
  );

/** The chat's run a usage limit stopped, when that is where the chat stands. */
const limitedRun = (thread: Thread) =>
  thread.status === "failed" && thread.lastErrorClass === "usage_limit" ? thread.latestRunId : null;

/**
 * Whether lease upkeep should move this box: its owner's chat stopped on a usage limit, on a
 * provider whose account can switch, in a run no switch has handled yet.
 */
export const autoSwitchDue = (lease: ProvisionedLease, chat: ProvisionedChat): boolean => {
  const runId = limitedRun(chat.thread);
  return (
    runId !== null &&
    switchableDriver(chat.thread.providerInstanceId) !== undefined &&
    !(lease.accountLimits ?? []).some((limit) => limit.runId === runId)
  );
};

const refused = (
  reason: Extract<EnvironmentProvisionSwitchAccountResult, { kind: "refused" }>["reason"],
  message: string,
): EnvironmentProvisionSwitchAccountResult => ({ kind: "refused", reason, message });

/**
 * Moves a box onto another host account of the provider `threadId` runs on, and continues the
 * chat's run when a usage limit stopped it. The account that hit the limit, and every account a
 * chat on this box hit a limit on before, stays out of rotation until it resets, so a run of
 * switches ends once no account is left. A run is handled once: every outcome but a busy chat,
 * failures included, records it, so upkeep never retries it on each sweep and the box can sleep.
 * A refusal leaves the box itself as it was.
 */
export async function switchLeaseAccount(
  lease: ProvisionedLease,
  threadId: ThreadId,
  ports: AccountSwitchPorts,
  leases: Pick<ProvisionedLeaseRegistry, "recordAccountSwitch" | "recordAccountLimit">,
  now = new Date(),
): Promise<EnvironmentProvisionSwitchAccountResult> {
  if (lease.state !== "active" || !lease.remoteAccess)
    return refused("asleep", "Wake this chat's cloud machine, then switch accounts.");
  const body = await ports.readShell(lease);
  const thread = body === null ? null : ownerChat(body, threadId)?.thread;
  if (!thread) return refused("unknown", "This chat could not be read on its cloud machine.");
  if (RUN_IN_FLIGHT.has(thread.status))
    return refused("busy", "This chat is working. Switch accounts once its turn ends.");
  const runId = limitedRun(thread);
  let current: string | undefined;
  const limit = (): AccountLimit | undefined =>
    runId === null
      ? undefined
      : {
          ...(current === undefined ? {} : { instanceId: current }),
          runId,
          until: limitedUntil(thread.usageLimitResetAt, now),
        };
  const attempt = async (): Promise<EnvironmentProvisionSwitchAccountResult> => {
    const driver = switchableDriver(thread.providerInstanceId);
    if (!driver) return refused("unsupported", "Only Claude and Codex chats can switch accounts.");
    let account: string | undefined;
    for (const instanceId of leaseAccounts(lease))
      if ((await ports.accountDriver(instanceId)) === driver) {
        account = instanceId;
        break;
      }
    if (account === undefined)
      return refused(
        "unsupported",
        "This machine's account for that provider is gone from this host.",
      );
    current = account;
    const exclude = new Set([
      account,
      ...(lease.accountLimits ?? []).flatMap((entry) =>
        entry.instanceId !== undefined && entry.until > now.toISOString() ? [entry.instanceId] : [],
      ),
    ]);
    const target = await ports.pickAccount(driver, exclude);
    if (!target)
      return refused(
        "no_account",
        "Every other account for this provider is out of usage or can't run in the cloud.",
      );
    const answer = await ports.sendSwitch(lease, {
      driver,
      ...(target.displayName ? { displayName: target.displayName } : {}),
      ...(target.accountEmail ? { accountEmail: target.accountEmail } : {}),
      credential: target.credential,
      threadId,
      ...(runId === null ? {} : { continueRunId: runId }),
    });
    if (answer === "missing")
      return refused(
        "unsupported",
        "This cloud machine runs an older build. It can switch accounts after its next update.",
      );
    if (answer.kind === "refused") return refused(answer.reason, answer.message);
    const handledLimit = limit();
    await leases.recordAccountSwitch(
      lease.leaseId,
      { from: account, to: target.instanceId, ...(handledLimit ? { limit: handledLimit } : {}) },
      now,
    );
    return { kind: "switched", account: target.name, continued: answer.continued };
  };
  const handled = async () => {
    const handledLimit = limit();
    if (handledLimit) await leases.recordAccountLimit(lease.leaseId, handledLimit, now);
  };
  const outcome = await attempt().catch(async (cause: unknown) => {
    await handled();
    throw cause;
  });
  if (outcome.kind === "refused" && outcome.reason !== "busy") await handled();
  return outcome;
}

/** Upkeep's account switch: when a box is due one, and running it under the box's lock. */
export function makeAccountRotation(input: {
  readonly ports: AccountSwitchPorts;
  readonly leases: Pick<
    ProvisionedLeaseRegistry,
    "findById" | "recordAccountSwitch" | "recordAccountLimit"
  >;
  /** The host's `autoSwitchCloudAccounts` setting. */
  readonly enabled: () => Promise<boolean>;
  /** Takes the box's per-box lock, or null while another operation holds it. */
  readonly holdBox: (sandboxId: string) => Promise<(() => void) | null>;
  readonly report: (
    lease: ProvisionedLease,
    outcome:
      | { readonly kind: "done"; readonly result: EnvironmentProvisionSwitchAccountResult }
      | { readonly kind: "failed"; readonly cause: unknown },
  ) => void;
}) {
  /** One switch under the box's lock, or a busy refusal while another operation holds it. */
  const switchUnderLock = async (
    lease: ProvisionedLease,
    threadId: ThreadId,
    due?: (lease: ProvisionedLease) => Promise<boolean>,
  ): Promise<EnvironmentProvisionSwitchAccountResult | null> => {
    const release = await input.holdBox(lease.sandboxId);
    if (!release)
      return refused("busy", "Another workspace operation is in progress. Retry shortly.");
    try {
      // Read again under the lock: a switch that ran meanwhile has already handled this run.
      const current = await input.leases.findById(lease.leaseId);
      if (!current || (due && !(await due(current)))) return null;
      return await switchLeaseAccount(current, threadId, input.ports, input.leases);
    } finally {
      release();
    }
  };
  return {
    due: async (lease: ProvisionedLease, chat: ProvisionedChat) =>
      autoSwitchDue(lease, chat) && (await input.enabled()),
    /** Upkeep's switch for a box whose owner chat stopped on a usage limit. Never rejects. */
    start: async (lease: ProvisionedLease): Promise<void> => {
      if (!lease.owner) return;
      const threadId = ThreadId.make(lease.owner.threadId);
      try {
        const result = await switchUnderLock(lease, threadId, async (current) => {
          const chat = ownerChat(await input.ports.readShell(current), threadId);
          return chat ? autoSwitchDue(current, chat) : false;
        });
        if (result) input.report(lease, { kind: "done", result });
      } catch (cause) {
        input.report(lease, { kind: "failed", cause });
      }
    },
    switchAccount: (lease: ProvisionedLease, threadId: ThreadId) =>
      switchUnderLock(lease, threadId),
  };
}

/** When an account that hit a limit is usable again: its reported reset, or a guess past it. */
const limitedUntil = (resetAt: string | null | undefined, now: Date) => {
  const reset = resetAt ? Date.parse(resetAt) : Number.NaN;
  return new Date(
    Number.isFinite(reset) && reset > now.getTime() ? reset : now.getTime() + UNKNOWN_RESET_MS,
  ).toISOString();
};

const encodeSwitchInput = Schema.encodeSync(Schema.fromJsonString(GuestAccountSwitchInput));
const decodeSwitchResult = Schema.decodeUnknownSync(GuestAccountSwitchResult);

/** Hands a box a new login over its published origin, with its broker token. */
export async function sendAccountSwitch(
  remote: RemoteAccess,
  input: GuestAccountSwitchInput,
): Promise<GuestAccountSwitchResult | "missing"> {
  const response = await fetch(`${remote.origin}/api/environment-control/switch-account`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${remote.brokerToken}`,
      "content-type": "application/json",
    },
    body: encodeSwitchInput(input),
    redirect: "error",
    // Waits out the box rebuilding its provider instance on the new login.
    signal: AbortSignal.timeout(90_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return "missing";
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `The cloud machine answered the account switch with status ${response.status}.`,
    );
  }
  return decodeSwitchResult(await response.json());
}
