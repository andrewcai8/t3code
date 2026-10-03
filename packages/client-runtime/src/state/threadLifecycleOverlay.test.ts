import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { workspaceMissingError } from "../connection/errors.ts";
import { EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { threadKey } from "./entities.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  applyThreadLifecycleOverlay,
  decodeThreadLifecycleOverlays,
  encodeThreadLifecycleOverlays,
  isOfflineThreadLifecycleDispatchResult,
  isThreadLifecycleOfflineFailure,
  OFFLINE_THREAD_LIFECYCLE_DISPATCH_RESULT,
  pendingThreadLifecycleFlushJobs,
  planThreadLifecycleOverlaySync,
  queueOfflineThreadLifecycleOverlay,
  reconcileThreadLifecycleOverlays,
  threadLifecycleOverlayAtom,
  type ThreadLifecycleOverlay,
  withThreadLifecycleOverlays,
} from "./threadLifecycleOverlay.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
const KEY = threadKey(REF);
const SETTLED_AT = "2026-09-15T12:00:00.000Z";
const SETTLED_AT_TIME = DateTime.makeUnsafe(SETTLED_AT);

const SHELL = {
  settledOverride: null as "settled" | "active" | null,
  settledAt: null as DateTime.Utc | null,
  unsettledAt: null as DateTime.Utc | null,
  activeOrderKey: "a" as string | null,
};

describe("applyThreadLifecycleOverlay", () => {
  it("parks a thread as settled without waiting for the server event", () => {
    const overlay = { kind: "settled" as const, at: SETTLED_AT };
    expect(applyThreadLifecycleOverlay(SHELL, overlay)).toEqual({
      settledOverride: "settled",
      settledAt: SETTLED_AT_TIME,
      unsettledAt: null,
      activeOrderKey: null,
    });
  });

  it("pins a locally un-settled thread active", () => {
    const overlay = { kind: "unsettled" as const, at: SETTLED_AT };
    expect(
      applyThreadLifecycleOverlay(
        { ...SHELL, settledOverride: "settled", settledAt: SETTLED_AT_TIME },
        overlay,
      ),
    ).toEqual({
      settledOverride: "active",
      settledAt: null,
      unsettledAt: SETTLED_AT_TIME,
      activeOrderKey: "a",
    });
  });

  it("returns the same object when the overlay is already applied", () => {
    const overlay = { kind: "settled" as const, at: SETTLED_AT };
    const settled = applyThreadLifecycleOverlay(SHELL, overlay);
    expect(applyThreadLifecycleOverlay(settled, overlay)).toBe(settled);
  });
});

describe("withThreadLifecycleOverlays", () => {
  const OTHER_THREAD_ID = ThreadId.make("thread-2");
  const source = Atom.make({
    ...v2ShellSnapshot,
    threads: [
      { ...v2ThreadShell, id: THREAD_ID },
      { ...v2ThreadShell, id: OTHER_THREAD_ID },
    ],
  });
  function harness() {
    const registry = AtomRegistry.make();
    const overlays = Atom.make<ReadonlyMap<string, ThreadLifecycleOverlay>>(new Map());
    const snapshotAtom = withThreadLifecycleOverlays(() => source, overlays)(ENVIRONMENT_ID);
    registry.mount(snapshotAtom);
    return { registry, overlays, snapshot: () => registry.get(snapshotAtom) };
  }

  it("hides a thread deleted on this device until the delete is undone", () => {
    const { registry, overlays, snapshot } = harness();
    registry.set(overlays, new Map([[KEY, { kind: "deleted", at: SETTLED_AT }]]));
    expect(snapshot()?.threads.map(({ id }) => id)).toEqual([OTHER_THREAD_ID]);
    registry.set(overlays, new Map());
    expect(snapshot()?.threads.map(({ id }) => id)).toEqual([THREAD_ID, OTHER_THREAD_ID]);
  });

  it("settles a thread in the snapshot and keeps its identity across recomputes", () => {
    const { registry, overlays, snapshot } = harness();
    expect(snapshot()).toBe(registry.get(source));
    registry.set(overlays, new Map([[KEY, { kind: "settled", at: SETTLED_AT }]]));
    const settled = snapshot()?.threads[0];
    expect([settled?.settledOverride, settled?.settledAt]).toEqual(["settled", SETTLED_AT_TIME]);
    expect(snapshot()?.threads[1]).toBe(registry.get(source).threads[1]);
    registry.set(
      overlays,
      new Map([
        [KEY, { kind: "settled", at: SETTLED_AT }],
        [
          threadKey({ environmentId: EnvironmentId.make("elsewhere"), threadId: THREAD_ID }),
          { kind: "deleted", at: SETTLED_AT },
        ],
      ]),
    );
    expect(snapshot()?.threads[0]).toBe(settled);
  });
});

describe("isThreadLifecycleOfflineFailure", () => {
  it("treats a missing RPC session as offline", () => {
    expect(
      isThreadLifecycleOfflineFailure(
        new EnvironmentRpcUnavailableError({
          environmentId: ENVIRONMENT_ID,
          message: "Cloud is not connected.",
        }),
      ),
    ).toBe(true);
  });

  it("treats an unregistered environment as offline", () => {
    expect(
      isThreadLifecycleOfflineFailure(
        new EnvironmentNotRegisteredError({ environmentId: ENVIRONMENT_ID }),
      ),
    ).toBe(true);
  });

  it("treats a workspace that no longer exists as offline", () => {
    expect(isThreadLifecycleOfflineFailure(workspaceMissingError())).toBe(true);
  });

  it("ignores business-logic settle failures", () => {
    expect(isThreadLifecycleOfflineFailure(new Error("Thread is still working."))).toBe(false);
  });
});

describe("isOfflineThreadLifecycleDispatchResult", () => {
  it("recognizes the local overlay ack", () => {
    expect(isOfflineThreadLifecycleDispatchResult(OFFLINE_THREAD_LIFECYCLE_DISPATCH_RESULT)).toBe(
      true,
    );
    expect(isOfflineThreadLifecycleDispatchResult({ sequence: 4 })).toBe(false);
  });
});

describe("thread lifecycle overlay persistence", () => {
  it("round-trips pending settle and un-settle records", () => {
    const encoded = encodeThreadLifecycleOverlays(
      new Map([[KEY, { kind: "settled", at: SETTLED_AT }]]),
    );
    expect(decodeThreadLifecycleOverlays(encoded).get(KEY)).toEqual({
      kind: "settled",
      at: SETTLED_AT,
    });
  });

  it("round-trips a pending delete", () => {
    const encoded = encodeThreadLifecycleOverlays(
      new Map([[KEY, { kind: "deleted", at: SETTLED_AT }]]),
    );
    expect(decodeThreadLifecycleOverlays(encoded).get(KEY)).toEqual({
      kind: "deleted",
      at: SETTLED_AT,
    });
  });

  it("drops malformed persisted records", () => {
    expect(decodeThreadLifecycleOverlays(JSON.stringify([{ kind: "settled" }])).size).toBe(0);
  });
});

describe("queueOfflineThreadLifecycleOverlay", () => {
  it("cancels a pending settle instead of flushing an un-settle", () => {
    const registry = AtomRegistry.make();
    queueOfflineThreadLifecycleOverlay(registry, REF, "settled", SETTLED_AT);
    expect(registry.get(threadLifecycleOverlayAtom).get(KEY)?.kind).toBe("settled");
    queueOfflineThreadLifecycleOverlay(registry, REF, "unsettled", "2026-09-15T12:01:00.000Z");
    expect(registry.get(threadLifecycleOverlayAtom).size).toBe(0);
  });

  it("lets a pending delete replace a pending settle and outlast a later settle", () => {
    const registry = AtomRegistry.make();
    queueOfflineThreadLifecycleOverlay(registry, REF, "settled", SETTLED_AT);
    queueOfflineThreadLifecycleOverlay(registry, REF, "deleted", "2026-09-15T12:01:00.000Z");
    queueOfflineThreadLifecycleOverlay(registry, REF, "settled", "2026-09-15T12:02:00.000Z");
    queueOfflineThreadLifecycleOverlay(registry, REF, "unsettled", "2026-09-15T12:03:00.000Z");
    expect(registry.get(threadLifecycleOverlayAtom).get(KEY)).toEqual({
      kind: "deleted",
      at: "2026-09-15T12:01:00.000Z",
    });
  });

  it("keeps the original overlay when the same kind is queued again", () => {
    const registry = AtomRegistry.make();
    queueOfflineThreadLifecycleOverlay(registry, REF, "settled", SETTLED_AT);
    queueOfflineThreadLifecycleOverlay(registry, REF, "settled", "2026-09-15T12:01:00.000Z");
    expect(registry.get(threadLifecycleOverlayAtom).get(KEY)).toEqual({
      kind: "settled",
      at: SETTLED_AT,
    });
  });
});

describe("reconcileThreadLifecycleOverlays", () => {
  it("keeps a pending settle until the live snapshot confirms it", () => {
    const overlays = new Map([[KEY, { kind: "settled" as const, at: SETTLED_AT }]]);
    expect(
      reconcileThreadLifecycleOverlays(overlays, {
        rawThreadsByKey: new Map([[KEY, { settledOverride: null }]]),
        liveCapableEnvironmentIds: new Set([ENVIRONMENT_ID]),
        liveIncapableEnvironmentIds: new Set(),
      }),
    ).toBe(overlays);
    expect(
      reconcileThreadLifecycleOverlays(overlays, {
        rawThreadsByKey: new Map([[KEY, { settledOverride: "settled" }]]),
        liveCapableEnvironmentIds: new Set([ENVIRONMENT_ID]),
        liveIncapableEnvironmentIds: new Set(),
      }).size,
    ).toBe(0);
  });

  it("drops overlays that cannot be flushed to an old server", () => {
    const overlays = new Map([[KEY, { kind: "settled" as const, at: SETTLED_AT }]]);
    expect(
      reconcileThreadLifecycleOverlays(overlays, {
        rawThreadsByKey: new Map([[KEY, { settledOverride: null }]]),
        liveCapableEnvironmentIds: new Set(),
        liveIncapableEnvironmentIds: new Set([ENVIRONMENT_ID]),
      }).size,
    ).toBe(0);
  });
});

describe("pendingThreadLifecycleFlushJobs", () => {
  it("only flushes overlays for connected servers that understand settlement", () => {
    const overlays = new Map([[KEY, { kind: "settled" as const, at: SETTLED_AT }]]);
    expect(
      pendingThreadLifecycleFlushJobs(overlays, {
        liveEnvironmentIds: new Set([ENVIRONMENT_ID]),
        liveCapableEnvironmentIds: new Set(),
      }).length,
    ).toBe(0);
    expect(
      pendingThreadLifecycleFlushJobs(overlays, {
        liveEnvironmentIds: new Set([ENVIRONMENT_ID]),
        liveCapableEnvironmentIds: new Set([ENVIRONMENT_ID]),
      }),
    ).toEqual([{ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, kind: "settled" }]);
  });
});

describe("planThreadLifecycleOverlaySync", () => {
  it("flushes a pending settle only after the environment is live and capable", () => {
    const overlays = new Map([[KEY, { kind: "settled" as const, at: SETTLED_AT }]]);
    const planned = planThreadLifecycleOverlaySync({
      overlays,
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          live: true,
          capabilities: { threadSettlement: true },
          snapshot: { threads: [{ id: THREAD_ID, settledOverride: null }] },
        },
      ],
    });
    expect(planned.overlays).toBe(overlays);
    expect(planned.jobs).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, kind: "settled" },
    ]);
  });

  it("replays a pending delete once the environment is live, whatever its settlement support", () => {
    const overlays = new Map([[KEY, { kind: "deleted" as const, at: SETTLED_AT }]]);
    const offline = planThreadLifecycleOverlaySync({
      overlays,
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          live: false,
          capabilities: undefined,
          snapshot: { threads: [{ id: THREAD_ID, settledOverride: null }] },
        },
      ],
    });
    expect(offline.jobs).toEqual([]);
    const planned = planThreadLifecycleOverlaySync({
      overlays,
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          live: true,
          capabilities: { threadSettlement: false },
          snapshot: { threads: [] },
        },
      ],
    });
    expect(planned.overlays).toBe(overlays);
    expect(planned.jobs).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, kind: "deleted" },
    ]);
  });

  it("keeps a disconnected overlay without flushing", () => {
    const overlays = new Map([[KEY, { kind: "settled" as const, at: SETTLED_AT }]]);
    const planned = planThreadLifecycleOverlaySync({
      overlays,
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          live: false,
          capabilities: { threadSettlement: true },
          snapshot: { threads: [{ id: THREAD_ID, settledOverride: null }] },
        },
      ],
    });
    expect(planned.overlays).toBe(overlays);
    expect(planned.jobs).toEqual([]);
  });
});
