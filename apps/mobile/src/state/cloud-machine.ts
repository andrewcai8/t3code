import { useAtomValue } from "@effect/atom-react";
import {
  type CloudMachine,
  type CloudMachineStatus,
  cloudMachineStatus,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";

const NO_MACHINE = Atom.make((): CloudMachine | null => null).pipe(
  Atom.withLabel("mobile-cloud-machine:none"),
);

/** A cloud chat's machine while it is asleep, waking or updating, as its host last said. */
export function useCloudMachine(environmentId: EnvironmentId | null): CloudMachine | null {
  return useAtomValue(
    environmentId === null ? NO_MACHINE : environmentCatalog.cloudMachineAtom(environmentId),
  );
}

/** Whether a chat's cloud machine is asleep, waking or updating; null while awake or not a box. */
export function useCloudMachineStatus(environmentId: EnvironmentId): CloudMachineStatus | null {
  const machine = useCloudMachine(environmentId);
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  return cloudMachineStatus(machine ?? undefined, presentation?.connection.phase);
}
