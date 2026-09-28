import { useAtomValue } from "@effect/atom-react";
import type { ProvisionedBoxes } from "@t3tools/client-runtime/cloud";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { provisioningHostIds } from "./new-task-project-selection";

function useProvisioningHostIds(serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>) {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  return useMemo(
    () => provisioningHostIds(serverConfigs, connectedEnvironments),
    [serverConfigs, connectedEnvironments],
  );
}

/**
 * Every cloud box the connected hosts among `serverConfigs` report. A phone that joined a box through a
 * pairing link keeps no record that it is a box, so the host that provisioned it is the only
 * place to ask. The lists are refetched when a reader mounts, since another device may have
 * claimed a box since they were last read.
 */
export function useProvisionedBoxes(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ProvisionedBoxes {
  const hostIds = useProvisioningHostIds(serverConfigs);
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

/**
 * Marks the saved cloud boxes their hosts report lost or disposed as missing, so none keeps
 * reconnecting or is offered for a new task. Mount once, app-wide. It reads the lists without
 * refetching them; the readers of `useProvisionedBoxes` do that.
 */
export function useMarkGoneProvisionedBoxes(): void {
  const hostIds = useProvisioningHostIds(useServerConfigs());
  const { boxes } = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  const markGone = useAtomCommand(environmentCatalog.markGoneWorkspacesMissing);
  useEffect(() => {
    void markGone(boxes);
  }, [boxes, markGone]);
}
