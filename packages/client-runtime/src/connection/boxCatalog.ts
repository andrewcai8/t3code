import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionCatalogEntry, ConnectionRegistration } from "./catalog.ts";
import { BearerConnectionTarget, type ConnectionTarget, connectionBox } from "./model.ts";

/**
 * Saves a box's target and leaves whatever pairing this device holds for it untouched. It is the
 * only way a bearer target is saved without a credential, and only a box may be: one its host
 * lists that this device has not opened yet.
 */
export class BoxTargetRegistration extends Schema.TaggedClass<BoxTargetRegistration>()(
  "BoxTargetRegistration",
  {
    target: BearerConnectionTarget.check(
      Schema.makeFilter((target) => target.box !== undefined || "A box target names its host."),
    ),
  },
) {}

/** Everything the registry persists: a registration, or a box's target alone. */
export type CatalogRegistration = ConnectionRegistration | BoxTargetRegistration;

/** Whether this device holds a pairing for a saved server, so reaching it needs no new one. */
export function holdsPairing(entry: ConnectionCatalogEntry | undefined): boolean {
  return entry !== undefined && Option.isSome(entry.profile);
}

/** A box its host listed that this device has never paired. Opening it pairs it first. */
export function isUnpairedBox(entry: ConnectionCatalogEntry): boolean {
  return connectionBox(entry.target) !== null && !holdsPairing(entry);
}

/**
 * Whether saving `registration` over `previous` keeps the profile and credential saved under the
 * unchanged connection id, so relabeling or marking a paired box never drops its pairing.
 */
export function keepsBoxPairing(
  registration: CatalogRegistration,
  previous: ConnectionTarget,
): boolean {
  return (
    registration._tag === "BoxTargetRegistration" &&
    previous._tag === "BearerConnectionTarget" &&
    previous.connectionId === registration.target.connectionId
  );
}
