import { EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ProvisionedBox } from "../cloud/provisioning.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
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

const BOX_PROFILE = new BearerConnectionProfile({
  connectionId: BOX.connectionId,
  environmentId: BOX.environmentId,
  label: BOX.label,
  httpBaseUrl: "https://e2b-box.example.test",
  wsBaseUrl: "wss://e2b-box.example.test",
});

function entry(target: ConnectionTarget): ConnectionCatalogEntry {
  return { target, profile: Option.none(), enabled: true };
}

function catalogWith(boxEntry: ConnectionCatalogEntry): EnvironmentCatalogState {
  return {
    isReady: true,
    entries: new Map([
      [HOST.environmentId, entry(HOST)],
      [BOX.environmentId, boxEntry],
    ]),
  };
}
const catalog = catalogWith({ ...entry(BOX), profile: Option.some(BOX_PROFILE) });

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
  type RunState = Pick<OrchestrationV2ThreadShell, "status" | "activityRunStatus">;
  function harness(input: {
    readonly thread: RunState;
    readonly lifecycle: ProvisionedBox["lifecycle"];
    readonly catalog?: EnvironmentCatalogState;
  }) {
    const registry = AtomRegistry.make();
    const threads = Atom.make<ReadonlyArray<RunState>>([input.thread]);
    const lifecycle = Atom.make(input.lifecycle);
    const held = new Set<EnvironmentId>();
    const demandAtom = Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => {
        held.add(environmentId);
        get.addFinalizer(() => held.delete(environmentId));
      }),
    );
    const atom = createRunningBoxDemandAtom({
      catalogValueAtom: Atom.make(input.catalog ?? catalog),
      threadsAtom: (environmentId) =>
        environmentId === BOX.environmentId ? threads : Atom.make([]),
      provisionedBoxes: () =>
        Atom.make((get) => [
          {
            managerId: HOST.environmentId,
            environmentId: BOX.environmentId,
            leaseId: "lease",
            threadId: null,
            lifecycle: get(lifecycle),
            label: "t3code · E2B",
            chat: null,
          },
        ]),
      demandAtom,
    });
    registry.mount(atom);
    return { registry, threads, lifecycle, held };
  }
  const running: RunState = { status: "running", activityRunStatus: "running" };
  const idle: RunState = { status: "idle", activityRunStatus: null };

  it.live("holds a box connected while a turn runs on it, and lets go when it ends", () =>
    Effect.gen(function* () {
      const { registry, threads, held } = harness({ thread: running, lifecycle: "active" });
      expect([...held]).toEqual([BOX.environmentId]);
      registry.set(threads, [idle]);
      // The registry drops an atom nothing mounts on its next task.
      yield* Effect.sleep("1 millis");
      expect([...held]).toEqual([]);
    }),
  );

  it("does not dial a box its host paused, whatever the cache last saw", () => {
    const { registry, lifecycle, held } = harness({ thread: running, lifecycle: "paused" });
    expect([...held]).toEqual([]);
    registry.set(lifecycle, "active");
    expect([...held]).toEqual([BOX.environmentId]);
  });

  it("holds a box that joined after its host's list was read once the list is fetched again", () => {
    const { registry, lifecycle, held } = harness({ thread: running, lifecycle: "missing" });
    // Stands in for the list read before the box existed.
    expect([...held]).toEqual([]);
    registry.set(lifecycle, "active");
    expect([...held]).toEqual([BOX.environmentId]);
  });

  it("does not pair a box this device never opened just because its listed chat is running", () => {
    expect([
      [...harness({ thread: running, lifecycle: "active", catalog: catalogWith(entry(BOX)) }).held],
      [...harness({ thread: running, lifecycle: "active" }).held],
    ]).toEqual([[], [BOX.environmentId]]);
  });

  it("holds a box while its turn starts, and not while it waits on the user or sits idle", () => {
    expect(
      (
        [
          { status: "starting", activityRunStatus: "starting" },
          { status: "running", activityRunStatus: "waiting" },
          { status: "waiting" },
          { status: "preparing", activityRunStatus: "preparing" },
          idle,
        ] satisfies ReadonlyArray<RunState>
      ).map((thread) => [...harness({ thread, lifecycle: "active" }).held]),
    ).toEqual([[BOX.environmentId], [], [], [], []]);
  });
});
