import { useAtomValue } from "@effect/atom-react";
import { createAutomationJoins, offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import {
  provisionedSandboxFor,
  provisionedSandboxOwnedByEnvironment,
} from "./provisionedSandboxLeases";
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
 * The cloud boxes a draft must not start on: every box the connected hosts report, however
 * this device came to know it, except the one the draft provisioned for itself. Only a draft
 * asks the hosts; anything else gets an empty set.
 */
export function useBoxesOfOtherChats(draftId: string | null): ReadonlySet<EnvironmentId> {
  const hosts = useAutomationHosts();
  const hostIds = useMemo(
    () => (draftId === null ? [] : hosts.map((host) => host.environmentId)),
    [draftId, hosts],
  );
  const boxes = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  const ownLeaseId = draftId === null ? null : (provisionedSandboxFor(draftId)?.leaseId ?? null);
  return useMemo(
    () => new Set(boxes.flatMap((box) => (box.leaseId === ownLeaseId ? [] : [box.environmentId]))),
    [boxes, ownLeaseId],
  );
}
