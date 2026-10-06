import { useAtomMount } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";

const NO_DEMAND = Atom.make(null).pipe(Atom.withLabel("mobile-environment-demand:none"));

/** Keeps a cloud box connected while mounted. Any other environment is unaffected. */
export function useBoxDemand(environmentId: EnvironmentId | null): void {
  useAtomMount(environmentId === null ? NO_DEMAND : environmentCatalog.demandAtom(environmentId));
}

const demandAllAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) => {
    for (const environmentId of JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>)
      get.mount(environmentCatalog.demandAtom(environmentId));
  }).pipe(Atom.withLabel(`mobile-environment-demand:${environmentIdsKey}`)),
);

/** Keeps every box among `environmentIds` connected while mounted. */
export function useBoxesDemand(environmentIds: ReadonlyArray<EnvironmentId>): void {
  useAtomMount(demandAllAtom(JSON.stringify([...new Set(environmentIds)].sort())));
}

/** Holds a box connected until the returned release runs, as while pairing or joining it. */
export function holdBoxDemand(environmentId: EnvironmentId): () => void {
  return appAtomRegistry.mount(environmentCatalog.demandAtom(environmentId));
}
