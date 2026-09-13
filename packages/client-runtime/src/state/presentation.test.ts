import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { createEnvironmentPresentationAtoms } from "./presentation.ts";
import type { EnvironmentShellState } from "./shell.ts";

it("keeps activity availability local to its environment and waits for fresh data on reconnect", () => {
  const first = EnvironmentId.make("first");
  const second = EnvironmentId.make("second");
  const connections = Atom.family((_id: EnvironmentId) =>
    Atom.make(
      AsyncResult.success<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
        desired: true,
      }),
    ),
  );
  const shells = Atom.family((_id: EnvironmentId) =>
    Atom.make<EnvironmentShellState>({
      status: "live",
      error: Option.none(),
      snapshot: Option.some({
        snapshotSequence: 1,
        updatedAt: "2026-09-13T12:00:00Z",
        projects: [],
        threads: [],
      }),
    }),
  );
  const atoms = createEnvironmentPresentationAtoms({
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map(
        [first, second].map((environmentId) => [
          environmentId,
          {
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: "http://localhost",
              wsBaseUrl: "ws://localhost",
            }),
            profile: Option.none(),
          },
        ]),
      ),
    }),
    stateAtom: connections,
    shellStateValueAtom: shells,
    serverConfigValueAtom: () => Atom.make(null),
  });
  const registry = AtomRegistry.make();
  const firstAvailability = atoms.activityAvailabilityAtom(first);
  const secondAvailability = atoms.activityAvailabilityAtom(second);
  try {
    const initial = registry.get(firstAvailability);
    expect(initial).toEqual({ kind: "live" });
    registry.set(
      connections(first),
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "backoff", desired: true }),
    );
    registry.set(shells(first), { ...registry.get(shells(first)), status: "cached" });
    expect(registry.get(firstAvailability)).toEqual({ kind: "unavailable", label: "Reconnecting" });
    expect(registry.get(secondAvailability)).toEqual({ kind: "live" });
    registry.set(
      connections(first),
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connected", desired: true }),
    );
    expect(registry.get(firstAvailability)).toEqual({ kind: "synchronizing" });
    registry.set(shells(first), {
      ...registry.get(shells(first)),
      error: Option.some("Sync request failed"),
    });
    expect(registry.get(firstAvailability)).toEqual({ kind: "unavailable", label: "Sync failed" });
    expect(registry.get(secondAvailability)).toEqual({ kind: "live" });
    registry.set(shells(first), {
      ...registry.get(shells(first)),
      status: "live",
      error: Option.none(),
    });
    expect(registry.get(firstAvailability)).toEqual({ kind: "live" });
    registry.set(shells(first), {
      ...registry.get(shells(first)),
      snapshot: Option.some({
        snapshotSequence: 2,
        updatedAt: "2026-09-13T12:01:00Z",
        projects: [],
        threads: [],
      }),
    });
    expect(registry.get(firstAvailability)).toBe(initial);
  } finally {
    registry.dispose();
  }
});
