import { provisionedGatewayPairingUrl } from "@t3tools/client-runtime/connection";
import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  rememberProvisionedSandbox,
  rememberProvisionedSandboxForEnvironment,
} from "../cloud/provisionedSandboxLeases";
import { useEnvironmentHttpBaseUrl, useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { waitForThreadShell } from "../state/waitForThreadShell";
import { connectPairing } from "./onboarding";
import { openProvisionedEnvironment } from "./provisioned";

/**
 * Connects this client to environments `managerId` provisioned. Settings and the automation
 * auto-join share it so both resume, route pairing through the manager's gateway, and record
 * the lease the heartbeat keeps alive.
 */
export function useProvisionedEnvironmentJoin(managerId: EnvironmentId) {
  const attach = useAtomCommand(serverEnvironment.attachProvisionedEnvironment, {
    reportFailure: false,
  });
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const { environments } = useEnvironments();
  const managerHttpBaseUrl = useEnvironmentHttpBaseUrl(managerId);
  const rewritePairingUrl = (pairingUrl: string, leaseId: string) =>
    managerHttpBaseUrl
      ? provisionedGatewayPairingUrl(managerHttpBaseUrl, leaseId, pairingUrl)
      : pairingUrl;

  async function attachForClient(environment: DiscoveredProvisionedEnvironment) {
    if (environment.lifecycle === "paused") {
      const resumed = await resume({
        environmentId: managerId,
        input: { environmentId: environment.environmentId },
        showsOwnProgress: true,
      });
      if (AsyncResult.isFailure(resumed))
        throw new Error("The manager could not resume this environment. Try again.");
      if (resumed.value.kind === "refused") throw new Error(resumed.value.message);
    }
    const result = await attach({
      environmentId: managerId,
      input: { requestId: environment.requestId },
      showsOwnProgress: true,
    });
    if (AsyncResult.isFailure(result))
      throw new Error("The manager could not issue a connection. Try again.");
    if (result.value.kind === "refused") throw new Error(result.value.message);
    return result.value;
  }

  return {
    /** A fresh pairing URL another device can use to reach the environment. */
    mintPairingUrl: async (environment: DiscoveredProvisionedEnvironment) => {
      const result = await attachForClient(environment);
      return rewritePairingUrl(result.pairingUrl, environment.leaseId);
    },
    /** Pairs this client with the environment; resolves with its thread once that has loaded. */
    join: (environment: DiscoveredProvisionedEnvironment) =>
      openProvisionedEnvironment(environment, {
        isConnected: (id) =>
          environments.some(
            (entry) => entry.environmentId === id && entry.connection.phase === "connected",
          ),
        attach: () => attachForClient(environment),
        pair: async (pairingUrl) => {
          const result = await pair({
            pairingUrl,
            expectedEnvironmentId: environment.environmentId,
          });
          if (AsyncResult.isFailure(result))
            throw new Error("The environment could not be connected. Try again.");
          return result.value;
        },
        rewritePairingUrl: (pairingUrl, lease) => rewritePairingUrl(pairingUrl, lease.leaseId),
        waitForThread: waitForThreadShell,
        rememberLease: (ref) => {
          const lease = {
            leaseId: environment.leaseId,
            sandboxId: environment.sandboxId,
            managerEnvironmentId: managerId,
          };
          if (ref === null)
            rememberProvisionedSandboxForEnvironment(environment.environmentId, lease);
          else rememberProvisionedSandbox(ref, lease);
        },
      }),
  };
}
