import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { connectionBox } from "@t3tools/client-runtime/connection";
import { createRunningBoxDemandAtom } from "@t3tools/client-runtime/state/boxDemand";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { hydrateProvisionStorage } from "../../state/provision-storage";
import { provisionedSandboxLeases } from "../../state/provision-stores";
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
 * The cloud boxes a new task never starts on, each mapped to the host that provisioned it: every
 * saved box but one this phone just started and no chat has taken yet.
 */
export function useOtherChatBoxes(): ReadonlyMap<EnvironmentId, EnvironmentId> {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  // The lease store is not reactive, and a box leaves it once its first chat starts, so the
  // boxes are read on every render and the map is rebuilt only when they change.
  const key = JSON.stringify(
    [...catalog.entries].flatMap(([environmentId, entry]) => {
      const box = connectionBox(entry.target);
      return box === null || provisionedSandboxLeases.awaitsFirstChat(environmentId)
        ? []
        : [[environmentId, box.managerId]];
    }),
  );
  return useMemo(
    () => new Map(JSON.parse(key) as ReadonlyArray<[EnvironmentId, EnvironmentId]>),
    [key],
  );
}

const runningBoxDemandAtom = createRunningBoxDemandAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  provisionedBoxes: serverEnvironment.provisionedBoxes,
  demandAtom: environmentCatalog.demandAtom,
});

/**
 * Keeps the saved catalog's boxes marked as boxes, marks those their hosts report lost or
 * disposed as missing, and keeps a box connected while a turn runs on it. A box saved before boxes
 * were marked is found in this phone's leases, then in the lists its host reports. Mount once,
 * app-wide. It reads the lists without refetching them; a box's open chat refetches its host's
 * list.
 */
export function useCloudBoxes(): void {
  const hostIds = useProvisioningHostIds(useServerConfigs());
  const boxes = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  const catalogReady = useAtomValue(environmentCatalog.catalogValueAtom).isReady;
  const markBoxes = useAtomCommand(environmentCatalog.markBoxes);
  const markGone = useAtomCommand(environmentCatalog.markGoneWorkspacesMissing);
  useEffect(() => {
    if (!catalogReady) return;
    // The lease store was made before the phone's provisioning file was read.
    void hydrateProvisionStorage().then(() => {
      provisionedSandboxLeases.reload();
      void markBoxes(provisionedSandboxLeases.boxes());
    });
  }, [catalogReady, markBoxes]);
  useEffect(() => {
    void markBoxes(boxes.map(({ environmentId, managerId }) => ({ environmentId, managerId })));
    void markGone(boxes);
  }, [boxes, markBoxes, markGone]);
  useAtomMount(runningBoxDemandAtom);
}

/**
 * Wakes a paused box through its host when its chat opens, then reconnects it. The host's list
 * is asked again on open, since the box may have paused since it was last read.
 */
export function useResumePausedBox(environmentId: EnvironmentId | null): void {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const target = environmentId === null ? undefined : catalog.entries.get(environmentId)?.target;
  const managerId = target === undefined ? null : (connectionBox(target)?.managerId ?? null);
  const hostIds = useMemo(() => (managerId === null ? [] : [managerId]), [managerId]);
  useEffect(() => {
    if (managerId !== null) serverEnvironment.refreshProvisionedBoxes(appAtomRegistry, [managerId]);
  }, [environmentId, managerId]);
  const boxes = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  const lifecycle = boxes.find((box) => box.environmentId === environmentId)?.lifecycle ?? null;
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  useEffect(() => {
    if (lifecycle !== "paused" || environmentId === null || managerId === null) return;
    void resume({ environmentId: managerId, input: { environmentId } }).then((result) => {
      if (AsyncResult.isSuccess(result) && result.value.kind === "resumed") {
        serverEnvironment.refreshProvisionedBoxes(appAtomRegistry, [managerId]);
        void retry(environmentId);
      }
    });
  }, [environmentId, lifecycle, managerId, resume, retry]);
}
