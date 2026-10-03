import { offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";

/** Connected hosts that offer cloud environments. */
export function useCloudHosts() {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          offeredProvisionProviders(environment.serverConfig).length > 0,
      ),
    [environments],
  );
}

/** Refetches a host's box list, as after a chat claims one of its boxes. */
export function refreshProvisionedEnvironments(managerId: EnvironmentId): void {
  serverEnvironment.refreshProvisionedBoxes(appAtomRegistry, [managerId]);
}

/** What placing a new chat with `newChatProject` reads: each user environment's state. */
export function useNewChatPlacement() {
  const { environments } = useEnvironments();
  return useMemo(() => {
    const environmentById = new Map(
      environments.map((environment) => [environment.environmentId, environment] as const),
    );
    return {
      environmentState: (environmentId: EnvironmentId) => environmentById.get(environmentId),
    };
  }, [environments]);
}
