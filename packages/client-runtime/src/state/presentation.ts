import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { withoutCloudBoxes } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { offeredProvisionProviders, type ProvisionedBoxes } from "../cloud/provisioning.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionBox,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import {
  presentEnvironmentConnection,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentPresentationAtoms<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>;
  /** Authoritative live server config, including streamed provider/settings updates. */
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  const presentationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entry = get(input.catalogValueAtom).entries.get(environmentId);
      if (entry === undefined) {
        return null;
      }
      const state = Option.getOrElse(
        AsyncResult.value(get(input.stateAtom(environmentId))),
        () => AVAILABLE_CONNECTION_STATE,
      );
      return {
        entry,
        connection:
          entry.unsupportedReason === undefined
            ? presentEnvironmentConnection(state, entry.target)
            : { phase: "unsupported", error: entry.unsupportedReason, traceId: null },
        serverConfig: get(input.serverConfigValueAtom(environmentId)),
      } satisfies EnvironmentPresentation;
    }).pipe(Atom.withLabel(`environment-presentation:${environmentId}`)),
  );

  let previous: ReadonlyMap<EnvironmentId, EnvironmentPresentation> = new Map();
  /**
   * Every saved environment but the cloud boxes, switched off ones included so Settings can list
   * them. A box belongs to its chat; read it through `presentationAtom`.
   */
  const presentationsAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentPresentation>();
    for (const [environmentId, entry] of get(input.catalogValueAtom).entries) {
      if (connectionBox(entry.target) !== null) continue;
      const presentation = get(presentationAtom(environmentId));
      if (presentation !== null) {
        next.set(environmentId, presentation);
      }
    }
    if (mapsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-presentations"));

  return {
    presentationAtom,
    presentationsAtom,
  };
}

/**
 * The presentations Limits reads accounts from: all but the cloud boxes that
 * the hosts among them list. Asking the hosts is the only way to know, since a
 * device that joined a box through a pairing link keeps no record that it is one.
 */
export function createLimitPresentationsAtom(input: {
  readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
  readonly provisionedBoxes: (hostIds: ReadonlyArray<EnvironmentId>) => Atom.Atom<ProvisionedBoxes>;
}) {
  return Atom.make((get) => {
    const presentations = get(input.presentationsAtom);
    const hostIds = [...presentations].flatMap(([environmentId, presentation]) =>
      offeredProvisionProviders(presentation.serverConfig).length > 0 ? [environmentId] : [],
    );
    if (hostIds.length === 0) return presentations;
    const { boxes } = get(input.provisionedBoxes(hostIds));
    return withoutCloudBoxes(presentations, new Set(boxes.map((box) => box.environmentId)));
  }).pipe(Atom.withLabel("environment-presentations:limits"));
}
