import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { ProvisionedBox } from "../cloud/provisioning.ts";
import { isUnpairedBox } from "../connection/catalog.ts";
import { connectionBox } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

type ThreadRunState = Pick<OrchestrationV2ThreadShell, "status" | "activityRunStatus">;

/** A turn is starting or running. A thread waiting on the user does not hold its box awake. */
function turnRunning({ status, activityRunStatus }: ThreadRunState): boolean {
  const current = activityRunStatus ?? status;
  return current === "starting" || current === "running";
}

/**
 * Keeps a cloud box connected while a turn runs on it, so its chat's status stays live with the
 * chat closed. A turn counts while the box's last known threads show one running and its host
 * lists the box active; a box the host paused or lost cannot be running one, whatever this client
 * last saw. A box this device never opened is left alone, so listing running chats pairs nothing.
 * Mount the result; its value lists the boxes it holds.
 */
export function createRunningBoxDemandAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly threadsAtom: (environmentId: EnvironmentId) => Atom.Atom<ReadonlyArray<ThreadRunState>>;
  readonly provisionedBoxes: (
    hostIds: ReadonlyArray<EnvironmentId>,
  ) => Atom.Atom<ReadonlyArray<ProvisionedBox>>;
  readonly demandAtom: (environmentId: EnvironmentId) => Atom.Atom<unknown>;
}) {
  return Atom.make((get): ReadonlyArray<EnvironmentId> => {
    const running = new Map<EnvironmentId, EnvironmentId>();
    for (const [environmentId, entry] of get(input.catalogValueAtom).entries) {
      const box = connectionBox(entry.target);
      if (box === null || !entry.enabled || isUnpairedBox(entry)) continue;
      if (get(input.threadsAtom(environmentId)).some(turnRunning))
        running.set(environmentId, box.managerId);
    }
    if (running.size === 0) return [];
    const boxes = get(input.provisionedBoxes([...new Set(running.values())]));
    const held = boxes.flatMap(({ environmentId, lifecycle }) =>
      lifecycle === "active" && running.has(environmentId) ? [environmentId] : [],
    );
    for (const environmentId of held) get.mount(input.demandAtom(environmentId));
    return held;
  }).pipe(Atom.withLabel("running-box-demand"));
}
