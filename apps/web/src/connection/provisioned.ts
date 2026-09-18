import {
  joinProvisionedEnvironment,
  type ProvisionedJoinPorts,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type DiscoveredProvisionedEnvironment, type ScopedThreadRef } from "@t3tools/contracts";

export interface ProvisionedConnectionPorts extends Omit<ProvisionedJoinPorts, "canReach"> {
  readonly waitForThread: (ref: ScopedThreadRef) => Promise<boolean>;
}

export async function openProvisionedEnvironment(
  environment: DiscoveredProvisionedEnvironment,
  ports: ProvisionedConnectionPorts,
): Promise<ScopedThreadRef | null> {
  const joined = await joinProvisionedEnvironment(environment, {
    ...ports,
    // The browser may be running on the manager itself, where even a loopback link works.
    canReach: () => true,
  });
  if (joined.kind !== "joined")
    throw new Error(
      joined.kind === "refused"
        ? joined.message
        : "This machine is reachable only through the computer that started it.",
    );
  if (environment.threadId === null) return null;
  const ref = scopeThreadRef(environment.environmentId, environment.threadId);
  if (!(await ports.waitForThread(ref)))
    throw new Error("Connected. The existing thread is still loading; try Open thread again.");
  return ref;
}
