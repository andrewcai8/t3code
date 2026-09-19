import type {
  DiscoveredProvisionedEnvironment,
  EnvironmentId,
  EnvironmentProvisionAttachResult,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

/** False for a loopback pairing URL: another device dialing it would reach itself, not the machine that minted it. */
export function isOffDeviceReachablePairingUrl(pairingUrl: string): boolean {
  try {
    return !isLoopbackHost(new URL(pairingUrl).hostname);
  } catch {
    return false;
  }
}

export interface ProvisionedJoinPorts {
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly attach: () => Promise<EnvironmentProvisionAttachResult>;
  readonly pair: (pairingUrl: string) => Promise<EnvironmentId>;
  /**
   * Whether this client can dial a minted pairing URL. A phone never reaches the manager's
   * loopback proxy; a browser running on the manager itself can.
   */
  readonly canReach: (pairingUrl: string) => boolean;
}

export type ProvisionedJoinOutcome =
  | { readonly kind: "joined" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Attach mints a fresh one-time pairing URL on every call, so joining is always a live action
 * and no link is kept between attempts. The URL is only handed to `pair` once this client can
 * actually reach it.
 */
export async function joinProvisionedEnvironment(
  environment: Pick<DiscoveredProvisionedEnvironment, "environmentId">,
  ports: ProvisionedJoinPorts,
): Promise<ProvisionedJoinOutcome> {
  if (ports.isConnected(environment.environmentId)) return { kind: "joined" };
  const attached = await ports.attach();
  if (attached.kind === "refused") return { kind: "refused", message: attached.message };
  if (attached.environmentId !== environment.environmentId)
    return { kind: "refused", message: "The connection belongs to another environment." };
  if (!ports.canReach(attached.pairingUrl)) return { kind: "unreachable" };
  const pairedId = await ports.pair(attached.pairingUrl);
  if (pairedId !== environment.environmentId)
    return { kind: "refused", message: "The paired server does not match this environment." };
  return { kind: "joined" };
}
