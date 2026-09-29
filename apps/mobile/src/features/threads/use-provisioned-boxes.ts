import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { ProvisionedBoxes } from "@t3tools/client-runtime/cloud";
import { connectionBox } from "@t3tools/client-runtime/connection";
import { createRunningBoxDemandAtom } from "@t3tools/client-runtime/state/boxDemand";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
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

const runningBoxDemandAtom = createRunningBoxDemandAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  provisionedBoxes: serverEnvironment.provisionedBoxes,
  demandAtom: environmentCatalog.demandAtom,
});

/**
 * Keeps the saved catalog's boxes marked as boxes, marks those their hosts report lost or
 * disposed as missing, and keeps a box connected while a turn runs on it. A box saved before boxes
 * were marked is found in the lists its host reports. Mount once, app-wide. It reads the lists
 * without refetching them; the readers of `useProvisionedBoxes` do that.
 */
export function useCloudBoxes(): void {
  const hostIds = useProvisioningHostIds(useServerConfigs());
  const { boxes } = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  const markBoxes = useAtomCommand(environmentCatalog.markBoxes);
  const markGone = useAtomCommand(environmentCatalog.markGoneWorkspacesMissing);
  useEffect(() => {
    void markBoxes(boxes.map(({ environmentId, managerId }) => ({ environmentId, managerId })));
    void markGone(boxes);
  }, [boxes, markBoxes, markGone]);
  useAtomMount(runningBoxDemandAtom);
}

const NO_DEMAND = Atom.make(null).pipe(Atom.withLabel("mobile-environment-demand:none"));

/** Keeps a cloud box connected while mounted. Any other environment is unaffected. */
export function useBoxDemand(environmentId: EnvironmentId | null): void {
  useAtomMount(environmentId === null ? NO_DEMAND : environmentCatalog.demandAtom(environmentId));
}

/** Holds a box connected until the returned release runs, as while pairing or joining it. */
export function holdBoxDemand(environmentId: EnvironmentId): () => void {
  return appAtomRegistry.mount(environmentCatalog.demandAtom(environmentId));
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
  const { boxes } = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
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
