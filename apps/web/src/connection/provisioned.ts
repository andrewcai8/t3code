import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DiscoveredProvisionedEnvironment,
  type EnvironmentId,
  type EnvironmentProvisionAttachResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";

export interface ProvisionedConnectionPorts {
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly attach: () => Promise<EnvironmentProvisionAttachResult>;
  readonly pair: (pairingUrl: string) => Promise<EnvironmentId>;
  readonly waitForThread: (ref: ScopedThreadRef) => Promise<boolean>;
}

export async function openProvisionedEnvironment(
  environment: DiscoveredProvisionedEnvironment,
  ports: ProvisionedConnectionPorts,
): Promise<ScopedThreadRef | null> {
  if (!ports.isConnected(environment.environmentId)) {
    const attached = await ports.attach();
    if (attached.kind === "refused") throw new Error(attached.message);
    if (attached.environmentId !== environment.environmentId)
      throw new Error("The connection belongs to another environment.");
    const pairedId = await ports.pair(attached.pairingUrl);
    if (pairedId !== environment.environmentId)
      throw new Error("The paired server does not match this environment.");
  }
  if (environment.threadId === null) return null;
  const ref = scopeThreadRef(environment.environmentId, environment.threadId);
  if (!(await ports.waitForThread(ref)))
    throw new Error("Connected. The existing thread is still loading; try Open thread again.");
  return ref;
}
