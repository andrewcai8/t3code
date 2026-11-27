import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { useVisibleInterval } from "../../hooks/useVisibleInterval";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { buildMachineRows, type MachineSample } from "./machines.logic";

const MACHINES_POLL_MS = 3_000;

// Keyed by content: the id list is derived every render.
const hostResourcesAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (environmentIdsKey === "" ? [] : (environmentIdsKey.split("\n") as EnvironmentId[])).map(
      (environmentId) => {
        const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
        // A failed refresh keeps the last snapshot so the row can say how old it is.
        const last =
          result._tag === "Success"
            ? result
            : result._tag === "Failure"
              ? Option.getOrNull(result.previousSuccess)
              : null;
        return {
          environmentId,
          resources: last?.value ?? null,
          receivedAt: last?.timestamp ?? 0,
          pending: result._tag === "Initial",
        };
      },
    ),
  ),
);

/**
 * Mount only while the Machines view is open: it polls every connected environment, and unmounting
 * releases the host-resources atoms so nothing is read in the background.
 */
export function useMachineRows() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const connectedIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId)
    .toSorted();
  const polled = useAtomValue(hostResourcesAtom(connectedIds.join("\n")));
  const [now, setNow] = useState(() => Date.now());

  useVisibleInterval(
    () => {
      setNow(Date.now());
      for (const environmentId of connectedIds) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    },
    MACHINES_POLL_MS,
    true,
  );

  const resourcesById = new Map(polled.map((entry) => [entry.environmentId, entry]));
  const samples = environments.map((environment): MachineSample => {
    const entry = resourcesById.get(environment.environmentId);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      connected: entry !== undefined,
      resources: entry?.resources ?? null,
      receivedAt: entry?.receivedAt ?? 0,
      pending: entry?.pending ?? false,
    };
  });
  return buildMachineRows(samples, now);
}
