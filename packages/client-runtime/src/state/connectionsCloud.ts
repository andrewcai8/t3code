import type { EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { HostBoxList } from "../cloud/provisioning.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  type ConnectionAttemptError,
  ConnectionTransientError,
  type SupervisorConnectionState,
  connectionBox,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { type AtomCommandScheduler, createRuntimeCommand } from "./runtime.ts";

/** Whether a saved connection reaches a cloud box rather than a machine the user picks. */
export const isBoxEntry = (entry: ConnectionCatalogEntry): boolean =>
  connectionBox(entry.target) !== null;

/**
 * The environments a user runs things on: enabled, and not a cloud box. A box belongs to its
 * chat, so it is never listed where a user picks a machine.
 */
export function* userEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.enabled && !isBoxEntry(entry)) {
      yield environmentId;
    }
  }
}

/**
 * Waits on an environment's connection states for a queued send: done once connected, failed once
 * blocked or switched off. There is no timeout, since waking a box can take many minutes. The state
 * current when the wait starts predates the retry its caller just asked for, so only a later block
 * counts.
 */
export const awaitConnection = <E, R>(
  states: Stream.Stream<SupervisorConnectionState, E, R>,
): Effect.Effect<void, E | ConnectionAttemptError | ConnectionTransientError, R> =>
  states.pipe(
    Stream.zipWithIndex,
    Stream.filter(
      ([state, index]) =>
        state.phase === "connected" ||
        state.phase === "available" ||
        (state.phase === "blocked" && index > 0),
    ),
    Stream.runHead,
    Effect.flatMap(
      (head): Effect.Effect<void, ConnectionAttemptError | ConnectionTransientError> => {
        const state = head._tag === "Some" ? head.value[0] : null;
        if (state?.phase === "connected") return Effect.void;
        if (state?.phase === "blocked" && state.lastFailure !== null)
          return Effect.fail(state.lastFailure);
        return Effect.fail(
          new ConnectionTransientError({
            reason: "transport",
            detail: "The environment was disconnected. The message is still in the composer.",
          }),
        );
      },
    ),
  );

/** Cloud box atoms and commands, spread into `createEnvironmentCatalogAtoms`. */
export function createEnvironmentCatalogCloudAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  input: {
    readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
    readonly commandScheduler: AtomCommandScheduler;
    readonly serial: { readonly mode: "serial"; readonly key: () => string };
  },
) {
  const { catalogValueAtom, commandScheduler, serial } = input;
  let previousBoxIds: ReadonlySet<EnvironmentIdType> = new Set();
  /** The saved connections that reach cloud boxes. */
  const boxIdsAtom = Atom.make((get) => {
    const next = new Set<EnvironmentIdType>();
    for (const [environmentId, entry] of get(catalogValueAtom).entries) {
      if (connectionBox(entry.target) !== null) next.add(environmentId);
    }
    if (next.size !== previousBoxIds.size || [...next].some((id) => !previousBoxIds.has(id))) {
      previousBoxIds = next;
    }
    return previousBoxIds;
  }).pipe(Atom.withLabel("environment-catalog-box-ids"));

  const markWorkspaceMissing = createRuntimeCommand(runtime, {
    label: "environment-catalog:mark-workspace-missing",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.markWorkspaceMissing(environmentId)),
      ),
  });
  /** Mounted while something needs a box connected, such as its open chat. */
  const demandAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime
      .atom(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((registry) => registry.demand(environmentId)),
        ),
      )
      .pipe(
        // Switching between chats should not drop and redial a box.
        Atom.setIdleTTL(15_000),
        Atom.withLabel(`environment-demand:${environmentId}`),
      ),
  );
  const demandedAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.demanded)),
      ),
    ),
    { initialValue: new Set<EnvironmentIdType>() as ReadonlySet<EnvironmentIdType> },
  );
  const demandedValueAtom = Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(demandedAtom)),
      (): ReadonlySet<EnvironmentIdType> => new Set(),
    ),
  ).pipe(Atom.withLabel("environment-demanded-value"));
  const markBoxes = createRuntimeCommand(runtime, {
    label: "environment-catalog:mark-boxes",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (
      boxes: Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["markBoxes"]>[0],
    ) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.markBoxes(boxes)),
      ),
  });
  const unmarkBox = createRuntimeCommand(runtime, {
    label: "environment-catalog:unmark-box",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.unmarkBox(environmentId)),
      ),
  });
  /** Follows each host's list of its boxes: see `EnvironmentRegistry.syncHostBoxes`. */
  const syncHostBoxes = createRuntimeCommand(runtime, {
    label: "environment-catalog:sync-host-boxes",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (lists: ReadonlyArray<HostBoxList>) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          Effect.forEach(
            lists,
            ({ managerId, boxes }) => registry.syncHostBoxes(managerId, boxes),
            {
              discard: true,
            },
          ),
        ),
      ),
  });
  const awaitConnected = createRuntimeCommand(runtime, {
    label: "environment-catalog:await-connected",
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => awaitConnection(registry.stateChanges(environmentId))),
      ),
  });

  return {
    boxIdsAtom,
    markWorkspaceMissing,
    syncHostBoxes,
    markBoxes,
    unmarkBox,
    demandAtom,
    demandedValueAtom,
    awaitConnected,
  };
}
