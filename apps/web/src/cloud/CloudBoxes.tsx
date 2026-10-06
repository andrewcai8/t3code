import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { createRunningBoxDemandAtom } from "@t3tools/client-runtime/state/boxDemand";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useCloudHosts } from "./cloudHosts";
import { provisionedSandboxLeases } from "./provisionedSandboxLeases";

const NO_DEMAND = Atom.make(null).pipe(Atom.withLabel("web-environment-demand:none"));

/** Keeps a cloud box connected while mounted. Any other environment is unaffected. */
export function useBoxDemand(environmentId: EnvironmentId | null): void {
  useAtomMount(environmentId === null ? NO_DEMAND : environmentCatalog.demandAtom(environmentId));
}

/** Holds a box connected until the returned release runs, as while pairing or joining it. */
export function holdBoxDemand(environmentId: EnvironmentId): () => void {
  return appAtomRegistry.mount(environmentCatalog.demandAtom(environmentId));
}

const runningBoxDemandAtom = createRunningBoxDemandAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  provisionedBoxes: serverEnvironment.provisionedBoxes,
  demandAtom: environmentCatalog.demandAtom,
});

/**
 * Keeps this device's boxes in line with the lists the connected hosts report, so every cloud
 * chat a host knows lists here and gone ones stop dialing, and keeps a box connected while a turn
 * runs on it. Boxes saved before they were marked are also found in this device's leases.
 */
export function CloudBoxes() {
  const catalogReady = useAtomValue(environmentCatalog.catalogValueAtom).isReady;
  const markBoxes = useAtomCommand(environmentCatalog.markBoxes);
  const syncHostBoxes = useAtomCommand(environmentCatalog.syncHostBoxes);
  useEffect(() => {
    if (!catalogReady) return;
    void markBoxes(provisionedSandboxLeases.boxes());
  }, [catalogReady, markBoxes]);

  const hosts = useCloudHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.environmentId), [hosts]);
  const lists = useAtomValue(serverEnvironment.hostBoxLists(hostIds));
  useEffect(() => {
    void syncHostBoxes(lists);
  }, [lists, syncHostBoxes]);

  useAtomMount(runningBoxDemandAtom);
  return null;
}
