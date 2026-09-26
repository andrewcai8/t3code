import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProvisionStorage } from "./storage.ts";

export const AUTOMATION_JOIN_ATTEMPTS_STORAGE_KEY = "t3code:automation-join-attempts:v1";
const AUTOMATION_JOIN_ATTEMPT_LIMIT = 200;
const decodeAttempts = Schema.decodeUnknownSync(Schema.Array(Schema.String));

/**
 * The environments a host started for automation runs that this device should join now, so
 * each run's chat shows in the sidebar. A run is joined once its chat exists, because the
 * lease heartbeat only follows leases recorded under a thread. Anything this device already
 * knows or already tried is skipped: a user who removed one is not re-joined, and a failing
 * join is not retried.
 */
export function automationEnvironmentsToJoin(
  discovered: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  known: ReadonlySet<EnvironmentId>,
  attempted: ReadonlySet<string>,
): ReadonlyArray<DiscoveredProvisionedEnvironment> {
  return discovered.filter(
    (environment) =>
      environment.automationId !== undefined &&
      environment.lifecycle === "active" &&
      environment.threadId !== null &&
      !known.has(environment.environmentId) &&
      !attempted.has(environment.requestId),
  );
}

/**
 * The provision request ids this device has tried to join, newest last and bounded. Storage is
 * read on every call so tabs sharing it see each other's attempts.
 */
export function createAutomationJoinAttempts(storage: ProvisionStorage) {
  function read(): ReadonlyArray<string> {
    const raw = storage.getItem(AUTOMATION_JOIN_ATTEMPTS_STORAGE_KEY);
    if (!raw) return [];
    try {
      return decodeAttempts(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  return {
    attempted: (): ReadonlySet<string> => new Set(read()),
    record: (requestId: string): void => {
      const attempts = read().filter((id) => id !== requestId);
      storage.setItem(
        AUTOMATION_JOIN_ATTEMPTS_STORAGE_KEY,
        JSON.stringify([...attempts, requestId].slice(-AUTOMATION_JOIN_ATTEMPT_LIMIT)),
      );
    },
  };
}
