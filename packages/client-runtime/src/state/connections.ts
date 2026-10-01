import type { EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE, connectionBox } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  GitHubRoutingPermissions,
  type GitHubRoutingPermission,
  type StoredGitHubRoutingPermission,
} from "../connection/githubRoutingPermissions.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  followStreamInEnvironment,
} from "./runtime.ts";

export interface EnvironmentCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>;
}

/**
 * Environments that take part in the workspace: projects, threads, and shell
 * summaries only come from these. Disabled environments stay in `entries` so
 * Settings can list them and switch them back on.
 */
export function* enabledEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.enabled) {
      yield environmentId;
    }
  }
}

/**
 * The environments a user runs things on: enabled, and not a cloud box. A box belongs to its
 * chat, so it is never listed where a user picks a machine.
 */
export function* userEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    if (connectionBox(catalog.entries.get(environmentId)!.target) === null) {
      yield environmentId;
    }
  }
}

const EMPTY_ENVIRONMENT_CATALOG_STATE: EnvironmentCatalogState = Object.freeze({
  isReady: false,
  entries: new Map(),
});

export function createEnvironmentCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = { mode: "serial" as const, key: () => "environment-catalog" };
  const catalogAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) =>
          SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries) => ({
              isReady: true,
              entries,
            })),
          ),
        ),
      ),
    ),
    { initialValue: EMPTY_ENVIRONMENT_CATALOG_STATE },
  );

  const catalogValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(catalogAtom)), () => EMPTY_ENVIRONMENT_CATALOG_STATE),
  ).pipe(Atom.withLabel("environment-catalog-value"));

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

  const githubRoutingPermissionsAtom = runtime.atom(
    Stream.unwrap(GitHubRoutingPermissions.pipe(Effect.map((permissions) => permissions.changes))),
    { initialValue: [] as ReadonlyArray<StoredGitHubRoutingPermission> },
  );
  const githubRoutingPermissionsValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(githubRoutingPermissionsAtom)), () => []),
  ).pipe(Atom.withLabel("environment-github-routing-permissions"));
  const setGitHubRoutingPermission = createRuntimeCommand(runtime, {
    label: "environment-catalog:github-routing-permission",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: Effect.fn(function* (input: {
      readonly environmentId: EnvironmentIdType;
      readonly permission: GitHubRoutingPermission;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
      if (entry === undefined)
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({
          environmentId: input.environmentId,
        });
      const permissions = yield* GitHubRoutingPermissions;
      yield* permissions.set(entry, input.permission);
    }),
  });

  const networkStatusAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.networkStatus)),
      ),
    ),
    { initialValue: "unknown" as const },
  );

  const networkStatusValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(networkStatusAtom)), () => "unknown" as const),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
          ),
        ),
      ),
      { initialValue: AVAILABLE_CONNECTION_STATE },
    ),
  );

  const register = createRuntimeCommand(runtime, {
    label: "environment-catalog:register",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (
      target: Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]>[0],
    ) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.register(target)),
      ),
  });
  const remove = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
      ),
  });
  const removeRelayEnvironments = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-relay-environments",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (_input: void) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRelayEnvironments()),
      ),
  });
  const setEnabled = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-enabled",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly enabled: boolean }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.setEnabled(input.environmentId, input.enabled)),
      ),
  });
  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
  });
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
  const markGoneWorkspacesMissing = createRuntimeCommand(runtime, {
    label: "environment-catalog:mark-gone-workspaces-missing",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: EnvironmentRegistry.markGoneWorkspacesMissing,
  });
  const awaitConnected = createRuntimeCommand(runtime, {
    label: "environment-catalog:await-connected",
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          // No timeout: waking a box can take many minutes, and a blocked connection fails here.
          // The state current when the wait starts predates the retry its caller just asked for,
          // so only a later block counts.
          registry.stateChanges(environmentId).pipe(
            Stream.zipWithIndex,
            Stream.filter(
              ([state, index]) =>
                state.phase === "connected" || (state.phase === "blocked" && index > 0),
            ),
            Stream.map(([state]) => state),
            Stream.runHead,
            Effect.flatMap(Effect.fromOption),
            Effect.flatMap((state) =>
              state.phase === "blocked" && state.lastFailure !== null
                ? Effect.fail(state.lastFailure)
                : Effect.void,
            ),
          ),
        ),
      ),
  });

  return {
    catalogAtom,
    catalogValueAtom,
    boxIdsAtom,
    githubRoutingPermissionsValueAtom,
    setGitHubRoutingPermission,
    networkStatusAtom,
    networkStatusValueAtom,
    stateAtom,
    register,
    remove,
    removeRelayEnvironments,
    retryNow,
    markWorkspaceMissing,
    markGoneWorkspacesMissing,
    markBoxes,
    unmarkBox,
    demandAtom,
    demandedValueAtom,
    awaitConnected,
    setEnabled,
  };
}
