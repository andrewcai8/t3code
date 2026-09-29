import { EnvironmentId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ProvisionedBox } from "../cloud/provisioning.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type ConnectionTarget,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import { createRunningBoxDemandAtom } from "./boxDemand.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentPresentationAtoms } from "./presentation.ts";

const HOST = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("host"),
  label: "andrew.megpt.app",
  httpBaseUrl: "https://andrew.megpt.app",
  wsBaseUrl: "wss://andrew.megpt.app",
});
const BOX = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("e2b-box"),
  label: "e2b.local",
  connectionId: "bearer:e2b-box",
  box: { managerId: HOST.environmentId },
});

function entry(target: ConnectionTarget): ConnectionCatalogEntry {
  return { target, profile: Option.none(), enabled: true };
}

const catalog: EnvironmentCatalogState = {
  isReady: true,
  entries: new Map([
    [HOST.environmentId, entry(HOST)],
    [BOX.environmentId, entry(BOX)],
  ]),
};

describe("environment presentations", () => {
  it("list the host but not the cloud box, which its chat still reads", () => {
    const registry = AtomRegistry.make();
    const atoms = createEnvironmentPresentationAtoms({
      catalogValueAtom: Atom.make(catalog),
      stateAtom: () => Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)),
      serverConfigValueAtom: () => Atom.make(null),
    });
    expect([...registry.get(atoms.presentationsAtom).keys()]).toEqual([HOST.environmentId]);
    expect(registry.get(atoms.presentationAtom(BOX.environmentId))?.entry.target).toEqual(BOX);
  });
});

describe("running box demand", () => {
  function harness(input: {
    readonly session: OrchestrationThreadShell["session"];
    readonly lifecycle: ProvisionedBox["lifecycle"];
  }) {
    const registry = AtomRegistry.make();
    const threads = Atom.make<ReadonlyArray<Pick<OrchestrationThreadShell, "session">>>([
      { session: input.session },
    ]);
    const lifecycle = Atom.make(input.lifecycle);
    const held = new Set<EnvironmentId>();
    const demandAtom = Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => {
        held.add(environmentId);
        get.addFinalizer(() => held.delete(environmentId));
      }),
    );
    const atom = createRunningBoxDemandAtom({
      catalogValueAtom: Atom.make(catalog),
      threadsAtom: (environmentId) =>
        environmentId === BOX.environmentId ? threads : Atom.make([]),
      provisionedBoxes: () =>
        Atom.make((get) => ({
          boxes: [
            {
              managerId: HOST.environmentId,
              environmentId: BOX.environmentId,
              leaseId: "lease",
              threadId: null,
              lifecycle: get(lifecycle),
            },
          ],
          refreshing: false,
        })),
      demandAtom,
    });
    registry.mount(atom);
    return { registry, threads, lifecycle, held };
  }
  const running = {
    threadId: "thread",
    status: "running",
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-28T00:00:00.000Z",
  } as unknown as OrchestrationThreadShell["session"];

  it.live("holds a box connected while a turn runs on it, and lets go when it ends", () =>
    Effect.gen(function* () {
      const { registry, threads, held } = harness({ session: running, lifecycle: "active" });
      expect([...held]).toEqual([BOX.environmentId]);
      registry.set(threads, [{ session: null }]);
      // The registry drops an atom nothing mounts on its next task.
      yield* Effect.sleep("1 millis");
      expect([...held]).toEqual([]);
    }),
  );

  it("does not dial a box its host paused, whatever the cache last saw", () => {
    const { registry, lifecycle, held } = harness({ session: running, lifecycle: "paused" });
    expect([...held]).toEqual([]);
    registry.set(lifecycle, "active");
    expect([...held]).toEqual([BOX.environmentId]);
  });

  it("does not hold a box with no running turn", () => {
    expect([...harness({ session: null, lifecycle: "active" }).held]).toEqual([]);
  });
});
