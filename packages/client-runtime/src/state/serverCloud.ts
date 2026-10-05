import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  type HostBoxList,
  type ProvisionedBox,
  provisionedBox,
  sameProvisionedBoxes,
} from "../cloud/provisioning.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { request, type EnvironmentRpcInput } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

/** Cloud box queries and environmentControl commands for `createServerEnvironmentAtoms`. */
export function createServerCloudAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const managedEnvironments = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:cloud:compute",
    staleTimeMs: 5_000,
    execute: (input: EnvironmentRpcInput<typeof WS_METHODS.environmentControlList>) =>
      request(WS_METHODS.environmentControlList, input).pipe(Effect.timeout("20 seconds")),
  });
  const provisionedEnvironments = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:cloud:provisioned",
    staleTimeMs: 5_000,
    execute: (input: EnvironmentRpcInput<typeof WS_METHODS.environmentControlListProvisioned>) =>
      request(WS_METHODS.environmentControlListProvisioned, input).pipe(
        Effect.timeout("20 seconds"),
      ),
  });
  // Asks about every saved environment, by id and by the address it is dialed at, so a host also
  // lists the saved ones that were its boxes and are gone, even one it disposed before it kept the
  // box's id. It also asks for each box's chat, naming the ones this runtime already holds so only
  // newer chats come back. The key stays `{}` so every reader shares one fetch per host; the ids are
  // read when it runs. Settings uses `provisionedEnvironments`, which never lists
  // gone boxes or chats.
  const provisionedBoxLists = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:cloud:provisioned-box-lists",
    staleTimeMs: 5_000,
    refreshIntervalMs: 60_000,
    execute: (_input: Record<string, never>) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const managerId = (yield* EnvironmentSupervisor.EnvironmentSupervisor).target.environmentId;
        const entries = yield* SubscriptionRef.get(registry.entries);
        const held = yield* SubscriptionRef.get(registry.hostChats);
        const rows = yield* request(WS_METHODS.environmentControlListProvisioned, {
          environmentIds: [...entries.keys()],
          addresses: [...entries].flatMap(([environmentId, { profile }]) =>
            Option.isSome(profile) && profile.value._tag === "BearerConnectionProfile"
              ? [{ environmentId, httpBaseUrl: profile.value.httpBaseUrl }]
              : [],
          ),
          chats: [...held].flatMap(([environmentId, { managerId: hostId, chat }]) =>
            hostId === managerId ? [{ environmentId, sequence: chat.sequence }] : [],
          ),
        });
        return rows.map((row) => provisionedBox(managerId, row));
      }).pipe(Effect.timeout("20 seconds")),
  });
  const hostBoxListsFamily = Atom.family((hostsKey: string) =>
    Atom.make((get): ReadonlyArray<HostBoxList> => {
      const lists = (JSON.parse(hostsKey) as ReadonlyArray<string>).flatMap((hostId) => {
        const managerId = EnvironmentId.make(hostId);
        const listed = get(provisionedBoxLists({ environmentId: managerId, input: {} }));
        return Option.match(AsyncResult.value(listed), {
          onNone: () => [],
          onSome: (boxes) => [{ managerId, boxes }],
        });
      });
      // Every refetch decodes a fresh list; keep the previous one while nothing in it changed so
      // views reading it do not re-render on each poll.
      const previous = Option.getOrNull(get.self<ReadonlyArray<HostBoxList>>());
      return previous !== null &&
        previous.length === lists.length &&
        previous.every(
          (list, index) =>
            list.managerId === lists[index]!.managerId &&
            sameProvisionedBoxes(list.boxes, lists[index]!.boxes),
        )
        ? previous
        : lists;
    }).pipe(Atom.withLabel(`environment-data:cloud:host-box-lists:${hostsKey}`)),
  );
  /** Each given host's list of its cloud boxes, for the hosts that have answered. */
  const hostBoxLists = (hostIds: ReadonlyArray<EnvironmentId>) =>
    hostBoxListsFamily(JSON.stringify([...hostIds].sort()));
  const provisionedBoxesFamily = Atom.family((hostsKey: string) =>
    Atom.make((get): ReadonlyArray<ProvisionedBox> =>
      get(hostBoxListsFamily(hostsKey)).flatMap(({ boxes }) => boxes),
    ).pipe(Atom.withLabel(`environment-data:cloud:provisioned-boxes:${hostsKey}`)),
  );
  /** Every cloud box the given hosts report, as far as each host has answered. */
  const provisionedBoxes = (hostIds: ReadonlyArray<EnvironmentId>) =>
    provisionedBoxesFamily(JSON.stringify([...hostIds].sort()));
  /** Refetches the hosts' box lists; a list is otherwise kept until nothing reads it. */
  const refreshProvisionedBoxes = (
    registry: AtomRegistry.AtomRegistry,
    hostIds: ReadonlyArray<EnvironmentId>,
  ) => {
    for (const environmentId of hostIds) {
      registry.refresh(provisionedBoxLists({ environmentId, input: {} }));
    }
  };
  const refreshManagedEnvironments = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(managedEnvironments({ environmentId: target.environmentId, input: {} })),
    );
  return {
    managedEnvironments,
    provisionedEnvironments,
    hostBoxLists,
    provisionedBoxes,
    refreshProvisionedBoxes,
    startManagedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:start",
      tag: WS_METHODS.environmentControlStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
      },
      onSettled: refreshManagedEnvironments,
    }),
    provisionEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:provision",
      tag: WS_METHODS.environmentControlProvision,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.requestId}`,
      },
    }),
    attachProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:attach",
      tag: WS_METHODS.environmentControlAttach,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.requestId}`,
      },
    }),
    disposeProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:dispose",
      tag: WS_METHODS.environmentControlDispose,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${"requestId" in input ? input.requestId : input.sandboxId}`,
      },
    }),
    keepProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:keep",
      tag: WS_METHODS.environmentControlKeep,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.requestId}`,
      },
    }),
    restoreProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:restore",
      tag: WS_METHODS.environmentControlRestore,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.leaseId}`,
      },
      // The host's next list names the box live again, which lets this device dial it.
      onSettled: (target, registry) =>
        Effect.sync(() => refreshProvisionedBoxes(registry, [target.environmentId])),
    }),
    pauseProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:pause",
      tag: WS_METHODS.environmentControlPause,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.sandboxId}`,
      },
    }),
    claimProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:claim",
      tag: WS_METHODS.environmentControlClaim,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.leaseId}`,
      },
    }),
    resumeProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:resume",
      tag: WS_METHODS.environmentControlResume,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
      },
    }),
    upgradeProvisionedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:upgrade",
      tag: WS_METHODS.environmentControlUpgrade,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.leaseId}`,
      },
    }),
    stopManagedEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cloud:stop",
      tag: WS_METHODS.environmentControlStop,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
      },
      onSettled: refreshManagedEnvironments,
    }),
  };
}
