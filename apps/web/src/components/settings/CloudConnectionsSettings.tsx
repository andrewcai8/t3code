import { runsLocalAgents } from "@t3tools/client-runtime/cloud";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { CloudComputeControls } from "./CloudComputeControls";
import { ProvisionedEnvironmentConnections } from "./ProvisionedEnvironmentConnections";
import { SavedCloudBoxConnections } from "./SavedCloudBoxConnections";

/**
 * The Connections page's cloud machines: each connected host's provisioned environments and
 * compute controls, then the cloud boxes saved on this device.
 */
export function CloudConnectionsSettings({
  environments,
  onSetEnabled,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => Promise<void>;
}) {
  return (
    <>
      {environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => (
          <div key={environment.environmentId}>
            <ProvisionedEnvironmentConnections
              managerId={environment.environmentId}
              managerLabel={environment.label}
            />
            <CloudComputeControls
              managerId={environment.environmentId}
              managerLabel={environment.label}
              onStarted={(id) => {
                if (!environments.some((entry) => entry.environmentId === id)) return false;
                void onSetEnabled(id, true);
                return true;
              }}
            />
          </div>
        ))}
      <SavedCloudBoxConnections />
    </>
  );
}

/** The machines load balancing offers: a host that runs no agents never receives a thread. */
export function useAgentRunningEnvironments(
  environments: ReadonlyArray<EnvironmentPresentation>,
): ReadonlyArray<EnvironmentPresentation> {
  return useMemo(
    () => environments.filter((environment) => runsLocalAgents(environment.serverConfig)),
    [environments],
  );
}
