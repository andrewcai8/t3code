import { createAutomationJoins, offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import { useMemo } from "react";

import { useEnvironments } from "../state/environments";
import { provisionedSandboxOwnedByEnvironment } from "./provisionedSandboxLeases";
import { localProvisionStorage } from "./provisionStorage";

export const automationJoins = createAutomationJoins(localProvisionStorage);

/**
 * Connected hosts that can run automations: they offer cloud environments, and are not a cloud
 * box this device reached through a host (by lease, or by joining an automation run).
 */
export function useAutomationHosts() {
  const { environments } = useEnvironments();
  return useMemo(() => {
    const joinedBoxes = new Set(automationJoins.joined().map((join) => join.environmentId));
    return environments.filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        offeredProvisionProviders(environment.serverConfig).length > 0 &&
        provisionedSandboxOwnedByEnvironment(environment.environmentId) === null &&
        !joinedBoxes.has(environment.environmentId),
    );
  }, [environments]);
}
