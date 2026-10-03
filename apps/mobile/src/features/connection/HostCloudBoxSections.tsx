import type { EnvironmentId } from "@t3tools/contracts";
import { Fragment } from "react";

import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { CloudComputeControls } from "./CloudComputeControls";
import { ProvisionedEnvironmentRows } from "./ProvisionedEnvironmentRows";
import { SavedCloudBoxConnections } from "./SavedCloudBoxConnections";

/**
 * Each connected host's cloud boxes. Given `onReconnectEnvironment`, also each host's compute
 * controls and the boxes this phone saved.
 */
export function HostCloudBoxSections(props: {
  readonly onReconnectEnvironment?: (environmentId: EnvironmentId) => void;
}) {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = props;
  return (
    <>
      {connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => (
          <Fragment key={environment.environmentId}>
            <ProvisionedEnvironmentRows
              managerId={environment.environmentId}
              managerLabel={environment.environmentLabel}
            />
            {onReconnectEnvironment ? (
              <CloudComputeControls
                managerId={environment.environmentId}
                managerLabel={environment.environmentLabel}
                onStarted={(id) => {
                  if (!connectedEnvironments.some((entry) => entry.environmentId === id))
                    return false;
                  onReconnectEnvironment(id);
                  return true;
                }}
              />
            ) : null}
          </Fragment>
        ))}
      {onReconnectEnvironment ? <SavedCloudBoxConnections /> : null}
    </>
  );
}
