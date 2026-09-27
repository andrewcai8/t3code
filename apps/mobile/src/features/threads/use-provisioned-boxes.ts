import { useAtomValue } from "@effect/atom-react";
import type { ProvisionedBoxes } from "@t3tools/client-runtime/cloud";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { provisioningHostIds } from "./new-task-project-selection";

/**
 * Every cloud box the connected hosts among `serverConfigs` report. A phone that joined a box through a
 * pairing link keeps no record that it is a box, so the host that provisioned it is the only
 * place to ask. The lists are refetched when a reader mounts, since another device may have
 * claimed a box since they were last read.
 */
export function useProvisionedBoxes(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ProvisionedBoxes {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const hostIds = useMemo(
    () => provisioningHostIds(serverConfigs, connectedEnvironments),
    [serverConfigs, connectedEnvironments],
  );
  const hostsKey = hostIds.join("\n");
  useEffect(() => {
    if (hostsKey === "") return;
    serverEnvironment.refreshProvisionedBoxes(
      appAtomRegistry,
      hostsKey.split("\n").map((hostId) => EnvironmentId.make(hostId)),
    );
  }, [hostsKey]);
  return useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
}
