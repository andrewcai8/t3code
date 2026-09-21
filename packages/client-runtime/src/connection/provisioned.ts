import type {
  DiscoveredProvisionedEnvironment,
  EnvironmentId,
  EnvironmentProvisionAttachResult,
} from "@t3tools/contracts";
import { PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX } from "@t3tools/shared/remote";
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
  /** Rewrite a manager-local pairing URL to a reachable manager-origin gateway. */
  readonly rewritePairingUrl?: (
    pairingUrl: string,
    environment: Pick<DiscoveredProvisionedEnvironment, "leaseId">,
  ) => string;
  /**
   * Whether this client can dial a minted pairing URL. A phone never reaches the manager's
   * loopback proxy; a browser running on the manager itself can.
   */
  readonly canReach: (pairingUrl: string) => boolean;
}

/** Replace a loopback Namespace proxy origin with the manager-origin guest gateway. */
export function provisionedGatewayPairingUrl(
  managerHttpBaseUrl: string,
  leaseId: string,
  pairingUrl: string,
): string {
  const source = new URL(pairingUrl);
  if (!isLoopbackHost(source.hostname)) return pairingUrl;
  const manager = new URL(managerHttpBaseUrl);
  const prefix = manager.pathname.endsWith("/") ? manager.pathname.slice(0, -1) : manager.pathname;
  manager.pathname = `${prefix}${PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX}/${encodeURIComponent(leaseId)}/pair`;
  manager.search = source.search;
  manager.hash = source.hash;
  return manager.toString();
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
  environment: Pick<DiscoveredProvisionedEnvironment, "environmentId" | "leaseId">,
  ports: ProvisionedJoinPorts,
): Promise<ProvisionedJoinOutcome> {
  if (ports.isConnected(environment.environmentId)) return { kind: "joined" };
  const attached = await ports.attach();
  if (attached.kind === "refused") return { kind: "refused", message: attached.message };
  if (attached.environmentId !== environment.environmentId)
    return { kind: "refused", message: "The connection belongs to another environment." };
  const pairingUrl =
    ports.rewritePairingUrl?.(attached.pairingUrl, environment) ?? attached.pairingUrl;
  if (!ports.canReach(pairingUrl)) return { kind: "unreachable" };
  const pairedId = await ports.pair(pairingUrl);
  if (pairedId !== environment.environmentId)
    return { kind: "refused", message: "The paired server does not match this environment." };
  return { kind: "joined" };
}
