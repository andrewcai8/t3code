import { EnvironmentId, ThreadId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { threadKey } from "./entities.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  type ThreadLifecycleOverlay,
  withThreadLifecycleOverlays,
} from "./threadLifecycleOverlay.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");

function makeHarness() {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  return { registry: AtomRegistry.make(), snapshotAtom, catalogValueAtom };
}

describe("v2 thread shell lists with lifecycle overlays", () => {
  it("hides a thread deleted on this device from lists and point reads until the delete is undone", () => {
    const { registry, snapshotAtom, catalogValueAtom } = makeHarness();
    const otherThreadId = ThreadId.make("other-thread");
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [v2ThreadShell, { ...v2ThreadShell, id: otherThreadId }],
    });
    const overlays = Atom.make<ReadonlyMap<string, ThreadLifecycleOverlay>>(new Map());
    const threads = createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom: withThreadLifecycleOverlays(snapshotAtom, overlays),
    });
    const ref = { environmentId, threadId: v2ThreadShell.id };
    const projectList = threads.threadShellsForProjectRefsAtom([
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const visible = () => ({
      list: registry.get(threads.threadShellsAtom).map(({ id }) => id),
      point: registry.get(threads.threadShellAtom(ref))?.id ?? null,
      project: registry.get(projectList).map(({ id }) => id),
    });

    registry.set(
      overlays,
      new Map([[threadKey(ref), { kind: "deleted", at: "2026-06-20T00:00:00.000Z" }]]),
    );
    expect(visible()).toEqual({ list: [otherThreadId], point: null, project: [otherThreadId] });

    registry.set(overlays, new Map());
    expect(visible()).toEqual({
      list: [v2ThreadShell.id, otherThreadId],
      point: v2ThreadShell.id,
      project: [v2ThreadShell.id, otherThreadId],
    });
    registry.dispose();
  });
});
