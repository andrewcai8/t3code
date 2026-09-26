import {
  EnvironmentId,
  recentAutomationEnvironments,
  ThreadId,
  type DiscoveredProvisionedEnvironment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProvisionStorage } from "./storage.ts";

const AUTOMATION_JOINS_STORAGE_KEY = "t3code:automation-joins:v1";
const AUTOMATION_JOIN_RECORD_LIMIT = 200;
const AUTOMATION_JOIN_MAX_FAILURES = 3;
const AUTOMATION_JOIN_RETRY_BASE_MS = 60_000;

/**
 * A run's environment this device joined without being asked. Its lease lives here rather than
 * in the lease store because the heartbeat renews every stored lease: an unopened run's box
 * should idle and pause like any other. Opening the chat moves the lease into the lease store.
 */
const AutomationJoin = Schema.Struct({
  requestId: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  leaseId: Schema.String,
  sandboxId: Schema.String,
  managerEnvironmentId: EnvironmentId,
});
const decodeJoins = Schema.decodeUnknownSync(Schema.Array(AutomationJoin));

/** Failed joins of one run this session. `retryAt` is `Infinity` once the device gives up. */
export interface AutomationJoinFailure {
  readonly failures: number;
  readonly retryAt: number;
}

/** Waits one minute after the first failure, two after the second, and stops at the third. */
export function recordAutomationJoinFailure(
  previous: AutomationJoinFailure | undefined,
  now: number,
): AutomationJoinFailure {
  const failures = (previous?.failures ?? 0) + 1;
  return {
    failures,
    retryAt:
      failures >= AUTOMATION_JOIN_MAX_FAILURES
        ? Infinity
        : now + AUTOMATION_JOIN_RETRY_BASE_MS * 2 ** (failures - 1),
  };
}

/**
 * The runs this device should join now, so their chats show in the sidebar: the host's recent
 * automation runs whose chat exists, minus any this device already knows, already joined (a user
 * who removed one keeps it removed), or is backing off from.
 */
export function automationEnvironmentsToJoin(
  joinable: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  device: {
    readonly now: number;
    readonly known: ReadonlySet<EnvironmentId>;
    readonly joined: ReadonlySet<string>;
    readonly failures: ReadonlyMap<string, AutomationJoinFailure>;
  },
) {
  return recentAutomationEnvironments(joinable, device.now).filter(
    (environment): environment is DiscoveredProvisionedEnvironment & { threadId: ThreadId } =>
      environment.threadId !== null &&
      !device.known.has(environment.environmentId) &&
      !device.joined.has(environment.requestId) &&
      (device.failures.get(environment.requestId)?.retryAt ?? -Infinity) <= device.now,
  );
}

/** How many joined-but-never-opened runs a device keeps connected at once. */
const AUTOMATION_UNOPENED_JOIN_CAP = 10;

/**
 * The joined runs whose saved connection this device should drop before joining `incoming` more
 * of `managerId`'s runs. Only connections still saved and never opened count: an opened chat is
 * the user's. Of those, a run of this host that left its joinable list (paused, gone, or aged
 * out) is dropped, and then the oldest until the new joins fit under the cap. `joins` is newest
 * last, as `createAutomationJoins` keeps it.
 */
export function automationJoinsToDrop(
  joins: ReadonlyArray<typeof AutomationJoin.Type>,
  device: {
    readonly managerId: EnvironmentId;
    readonly joinable: ReadonlyArray<DiscoveredProvisionedEnvironment>;
    readonly known: ReadonlySet<EnvironmentId>;
    readonly opened: ReadonlySet<string>;
    readonly incoming: number;
  },
): ReadonlyArray<typeof AutomationJoin.Type> {
  const listed = new Set<string>(device.joinable.map((environment) => environment.requestId));
  const unopened = joins.filter(
    (join) => device.known.has(join.environmentId) && !device.opened.has(join.requestId),
  );
  const left = unopened.filter(
    (join) => join.managerEnvironmentId === device.managerId && !listed.has(join.requestId),
  );
  const kept = unopened.filter((join) => !left.includes(join));
  const overflow = Math.max(0, kept.length + device.incoming - AUTOMATION_UNOPENED_JOIN_CAP);
  return [...left, ...kept.slice(0, overflow)];
}

/** Joins this device made, newest last and bounded. Read on every call so tabs share them. */
export function createAutomationJoins(storage: ProvisionStorage) {
  function joined(): ReadonlyArray<typeof AutomationJoin.Type> {
    const raw = storage.getItem(AUTOMATION_JOINS_STORAGE_KEY);
    if (!raw) return [];
    try {
      return decodeJoins(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  return {
    joined,
    record: (join: typeof AutomationJoin.Type): void => {
      const others = joined().filter((entry) => entry.requestId !== join.requestId);
      storage.setItem(
        AUTOMATION_JOINS_STORAGE_KEY,
        JSON.stringify([...others, join].slice(-AUTOMATION_JOIN_RECORD_LIMIT)),
      );
    },
  };
}
