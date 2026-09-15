import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { threadKey } from "./entities.ts";
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
} from "./threadLifecycleOverlay.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
const KEY = threadKey(REF);
const SETTLED_AT = "2026-09-15T12:00:00.000Z";

const SHELL = {
  settledOverride: null as "settled" | "active" | null,
  settledAt: null as string | null,
  unsettledAt: null as string | null,
  activeOrderKey: "a" as string | null,
};

describe("applyThreadLifecycleOverlay", () => {
  it("parks a thread as settled without waiting for the server event", () => {
    const overlay = { kind: "settled" as const, at: SETTLED_AT };
    expect(applyThreadLifecycleOverlay(SHELL, overlay)).toEqual({
      settledOverride: "settled",
      settledAt: SETTLED_AT,
      unsettledAt: null,
      activeOrderKey: null,
    });
  });

  it("pins a locally un-settled thread active", () => {
    const overlay = { kind: "unsettled" as const, at: SETTLED_AT };
    expect(
      applyThreadLifecycleOverlay(
        { ...SHELL, settledOverride: "settled", settledAt: SETTLED_AT },
        overlay,
      ),
    ).toEqual({
      settledOverride: "active",
      settledAt: null,
      unsettledAt: SETTLED_AT,
      activeOrderKey: "a",
    });
  });

  it("returns the same object when the overlay is already applied", () => {
    const overlay = { kind: "settled" as const, at: SETTLED_AT };
    const settled = applyThreadLifecycleOverlay(SHELL, overlay);
    expect(applyThreadLifecycleOverlay(settled, overlay)).toBe(settled);
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
    expect(pendingThreadLifecycleFlushJobs(overlays, new Set()).length).toBe(0);
    expect(pendingThreadLifecycleFlushJobs(overlays, new Set([ENVIRONMENT_ID]))).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID, kind: "settled" },
    ]);
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
