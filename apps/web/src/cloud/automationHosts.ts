import { useAtomValue } from "@effect/atom-react";
import {
  boxesOfOtherChats,
  createAutomationJoins,
  offeredProvisionProviders,
} from "@t3tools/client-runtime/cloud";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

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
 * The cloud boxes a draft must not start on: every box the connected hosts list as claimed by
 * another chat, however this device came to know it. Only a draft asks the hosts; anything else
 * gets an empty map.
 */
export function useBoxesOfOtherChats(
  draftId: string | null,
  threadId: ThreadId,
): ReadonlyMap<EnvironmentId, EnvironmentId> {
  const hosts = useAutomationHosts();
  const hostIds = useMemo(
    () => (draftId === null ? [] : hosts.map((host) => host.environmentId)),
    [draftId, hosts],
  );
  const boxes = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  return useMemo(() => boxesOfOtherChats(boxes, threadId), [boxes, threadId]);
}
