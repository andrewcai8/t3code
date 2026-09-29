import type { ProvisionedSandboxLease } from "@t3tools/client-runtime/cloud";
import { provisionedGatewayPairingUrl } from "@t3tools/client-runtime/connection";
import type {
  DiscoveredProvisionedEnvironment,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  rememberProvisionedSandbox,
  rememberProvisionedSandboxForEnvironment,
} from "../cloud/provisionedSandboxLeases";
import { holdBoxDemand } from "../cloud/CloudBoxes";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { waitForThreadShell } from "../state/waitForThreadShell";
import { connectPairing } from "./onboarding";
import { openProvisionedEnvironment } from "./provisioned";

/** Where a joined environment's lease goes. `ref` is null when the environment has no thread. */
type RememberLease = (
  environment: DiscoveredProvisionedEnvironment,
  ref: ScopedThreadRef | null,
  lease: ProvisionedSandboxLease,
) => void;

/** The lease store, whose leases the heartbeat renews: for a user opening the environment. */
const keepLeaseAwake: RememberLease = (environment, ref, lease) => {
  if (ref === null) rememberProvisionedSandboxForEnvironment(environment.environmentId, lease);
  else rememberProvisionedSandbox(ref, lease);
};

/**
 * Connects this client to boxes `managerId` provisioned for automation runs. Run history and the
 * auto-join share it so both resume, route pairing through the manager's gateway, and record the
 * lease.
 */
export function useProvisionedEnvironmentJoin(managerId: EnvironmentId) {
  const attach = useAtomCommand(serverEnvironment.attachProvisionedEnvironment, {
    reportFailure: false,
  });
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
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
    /** Pairs this client with the environment; resolves with its thread once that has loaded. */
    join: async (environment: DiscoveredProvisionedEnvironment, remember = keepLeaseAwake) => {
      // Joining waits for the box's thread, which needs it connected; its chat holds it after.
      const release = holdBoxDemand(environment.environmentId);
      try {
        return await joinEnvironment(environment, remember);
      } finally {
        release();
      }
    },
  };

  function joinEnvironment(environment: DiscoveredProvisionedEnvironment, remember: RememberLease) {
    return openProvisionedEnvironment(environment, {
      isConnected: (id) =>
        appAtomRegistry.get(environmentPresentations.presentationAtom(id))?.connection.phase ===
        "connected",
      attach: () => attachForClient(environment),
      pair: async (pairingUrl) => {
        const result = await pair({
          pairingUrl,
          expectedEnvironmentId: environment.environmentId,
          box: { managerId },
        });
        if (AsyncResult.isFailure(result))
          throw new Error("The environment could not be connected. Try again.");
        return result.value;
      },
      rewritePairingUrl: (pairingUrl, lease) => rewritePairingUrl(pairingUrl, lease.leaseId),
      waitForThread: waitForThreadShell,
      refreshBoxList: () => serverEnvironment.refreshProvisionedBoxes(appAtomRegistry, [managerId]),
      rememberLease: (ref) =>
        remember(environment, ref, {
          leaseId: environment.leaseId,
          sandboxId: environment.sandboxId,
          managerEnvironmentId: managerId,
        }),
    });
  }
}
