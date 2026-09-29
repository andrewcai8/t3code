import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentPresentationAtoms,
  createLimitPresentationsAtom,
} from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "./server";

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const limitPresentationsAtom = createLimitPresentationsAtom({
  presentationsAtom: environmentPresentations.presentationsAtom,
  provisionedBoxes: serverEnvironment.provisionedBoxes,
});

let previousConnectionPhases: ReadonlyMap<EnvironmentId, EnvironmentConnectionPhase> = new Map();
/**
 * Each enabled environment's connection phase, cloud boxes included. What sends to a chat reads,
 * since a chat's machine may be a box, which no environment list shows.
 */
export const connectionPhasesAtom = Atom.make((get) => {
  const next = new Map<EnvironmentId, EnvironmentConnectionPhase>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    if (presentation !== null) next.set(environmentId, presentation.connection.phase);
  }
  if (
    next.size !== previousConnectionPhases.size ||
    [...next].some(
      ([environmentId, phase]) => previousConnectionPhases.get(environmentId) !== phase,
    )
  ) {
    previousConnectionPhases = next;
  }
  return previousConnectionPhases;
}).pipe(Atom.withLabel("mobile-environment-connection-phases"));

const EMPTY_ENVIRONMENT_PRESENTATION_ATOM = Atom.make<EnvironmentPresentation | null>(null).pipe(
  Atom.withLabel("mobile-environment-presentation:empty"),
);

export function useEnvironmentPresentation(environmentId: EnvironmentId | null) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const presentation = useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_PRESENTATION_ATOM
      : environmentPresentations.presentationAtom(environmentId),
  );
  return {
    isReady: catalog.isReady,
    presentation,
  };
}
