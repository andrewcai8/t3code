import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { ProvisionedBoxes } from "../cloud/provisioning.ts";
import { connectionBox } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { isThreadSessionRunning } from "./threads.ts";

/**
 * Keeps a cloud box connected while a turn runs on it, so its chat's status stays live with the
 * chat closed. A turn counts while the box's last known threads show one running and its host
 * lists the box active; a box the host paused or lost cannot be running one, whatever this client
 * last saw. Mount the result; its value lists the boxes it holds.
 */
export function createRunningBoxDemandAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly threadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<Pick<OrchestrationThreadShell, "session">>>;
  readonly provisionedBoxes: (hostIds: ReadonlyArray<EnvironmentId>) => Atom.Atom<ProvisionedBoxes>;
  readonly demandAtom: (environmentId: EnvironmentId) => Atom.Atom<unknown>;
}) {
  return Atom.make((get): ReadonlyArray<EnvironmentId> => {
    const running = new Map<EnvironmentId, EnvironmentId>();
    for (const [environmentId, entry] of get(input.catalogValueAtom).entries) {
      const box = connectionBox(entry.target);
      if (box === null || !entry.enabled) continue;
      if (
        get(input.threadsAtom(environmentId)).some(({ session }) => isThreadSessionRunning(session))
      )
        running.set(environmentId, box.managerId);
    }
    if (running.size === 0) return [];
    const { boxes } = get(input.provisionedBoxes([...new Set(running.values())]));
    const held = boxes.flatMap(({ environmentId, lifecycle }) =>
      lifecycle === "active" && running.has(environmentId) ? [environmentId] : [],
    );
    for (const environmentId of held) get.mount(input.demandAtom(environmentId));
    return held;
  }).pipe(Atom.withLabel("running-box-demand"));
}
