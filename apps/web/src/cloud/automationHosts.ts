import { useAtomValue } from "@effect/atom-react";
import {
  boxesOfOtherChats,
  createAutomationJoins,
  idleProvisionedBoxes,
  offeredProvisionProviders,
} from "@t3tools/client-runtime/cloud";
import { EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
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

/**
 * Whether any known environment offers cloud machines. Connection phase is ignored, so a
 * reconnect does not add and remove the entry points.
 */
export function useAutomationsAvailable(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) => offeredProvisionProviders(environment.serverConfig).length > 0,
  );
}

/** Refetches a host's box list, as after a chat claims one of its boxes. */
export function refreshProvisionedEnvironments(managerId: EnvironmentId): void {
  serverEnvironment.refreshProvisionedBoxes(appAtomRegistry, [managerId]);
}

/**
 * The cloud boxes a draft must not start on, as the connected hosts list them however this device
 * came to know each: those another chat claimed, and those paused or lost. A draft refetches the
 * lists when it opens, since another device may have claimed a box since, and must not send while
 * `refreshing`. Only a draft asks the hosts; anything else gets empty collections.
 */
export function useNewChatBoxes(
  draftId: string | null,
  threadId: ThreadId,
): {
  readonly others: ReadonlyMap<EnvironmentId, EnvironmentId>;
  readonly idle: ReadonlySet<EnvironmentId>;
  readonly refreshing: boolean;
} {
  const hosts = useAutomationHosts();
  const hostIds = useMemo(
    () => (draftId === null ? [] : hosts.map((host) => host.environmentId)),
    [draftId, hosts],
  );
  const hostsKey = hostIds.join("\n");
  useEffect(() => {
    // Every draft that opens refetches, even when the hosts are unchanged.
    if (draftId === null || hostsKey === "") return;
    serverEnvironment.refreshProvisionedBoxes(
      appAtomRegistry,
      hostsKey.split("\n").map((hostId) => EnvironmentId.make(hostId)),
    );
  }, [draftId, hostsKey]);
  const { boxes, refreshing } = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  return useMemo(
    () => ({
      others: boxesOfOtherChats(boxes, threadId),
      idle: idleProvisionedBoxes(boxes),
      refreshing,
    }),
    [boxes, refreshing, threadId],
  );
}
