import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EnvironmentProvisionInput,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  drainProvisionCancellations,
  forgetProvisionRequest,
  isProvisionRequestActive,
  reserveProvisionRequest,
} from "./provisionRequests";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

const persisted = new Map<string, string>();
const request = {
  managerEnvironmentId: EnvironmentId.make("manager"),
  input: {
    provider: "e2b",
    providerInstanceId: "codex-account",
    agentDriver: ProviderDriverKind.make("codex"),
    repository: "example/repository",
  } satisfies Omit<EnvironmentProvisionInput, "requestId">,
};

beforeEach(() => {
  persisted.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => persisted.get(key) ?? null,
    setItem: (key: string, value: string) => persisted.set(key, value),
    removeItem: (key: string) => {
      persisted.delete(key);
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("draft provisioning requests over localStorage", () => {
  it("persists the request under the browser key and recovers it after a reload", async () => {
    const first = reserveProvisionRequest("draft-1", request);
    expect(first.input.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    expect([...persisted.keys()]).toEqual(["t3code:draft-provision-requests:v1"]);
    expect(JSON.parse(persisted.get("t3code:draft-provision-requests:v1")!)).toEqual({
      "draft-1": first,
    });
    vi.resetModules();
    const reloaded = await import("./provisionRequests");
    expect(reloaded.reserveProvisionRequest("draft-1", request)).toEqual(first);
  });

  it("does not return an allocatable request if persistence fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    });
    expect(() => reserveProvisionRequest("draft-1", request)).toThrow("storage unavailable");
  });

  it("keeps a completed send successful when request cleanup cannot be persisted", () => {
    const first = reserveProvisionRequest("draft-1", request);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    });
    expect(forgetProvisionRequest("draft-1")).toBe(false);
    expect(reserveProvisionRequest("draft-1", request)).toEqual(first);
  });
});

describe("draft deletion and promotion", () => {
  it.each([
    "clearDraftThread",
    "clearProjectDraftThreadById",
    "clearProjectDraftThreadId",
  ] as const)("%s cancels a draft request before any lease exists", async (method) => {
    const draftId = DraftId.make("delete-before-allocation");
    const saved = reserveProvisionRequest(draftId, request);
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(
      scopeProjectRef(EnvironmentId.make("manager"), ProjectId.make("project")),
      draftId,
      { threadId: ThreadId.make("thread") },
    );
    const projectRef = scopeProjectRef(EnvironmentId.make("manager"), ProjectId.make("project"));
    if (method === "clearDraftThread") store.clearDraftThread(draftId);
    else if (method === "clearProjectDraftThreadById")
      store.clearProjectDraftThreadById(projectRef, draftId);
    else store.clearProjectDraftThreadId(projectRef);
    expect(store.getDraftSession(draftId)).toBe(null);
    expect(isProvisionRequestActive(draftId)).toBe(false);
    expect(
      await drainProvisionCancellations(async (pending) => {
        expect(pending.managerEnvironmentId).toBe(saved.managerEnvironmentId);
        expect(pending.input.requestId).toBe(saved.input.requestId);
        return { kind: "disposed" };
      }),
    ).toEqual([draftId]);
  });

  it("keeps an environment when its draft is promoted into a thread", async () => {
    const draftId = DraftId.make("promoted-draft");
    reserveProvisionRequest(draftId, request);
    const store = useComposerDraftStore.getState();
    const environmentId = EnvironmentId.make("manager");
    store.setProjectDraftThreadId(
      scopeProjectRef(environmentId, ProjectId.make("promotion-project")),
      draftId,
      { threadId: ThreadId.make("promotion-thread") },
    );
    store.markDraftThreadPromoting(
      draftId,
      scopeThreadRef(environmentId, ThreadId.make("promotion-thread")),
    );
    store.finalizePromotedDraftThread(draftId);
    expect(isProvisionRequestActive(draftId)).toBe(true);
    const dispose = vi.fn(async () => ({ kind: "disposed" as const }));
    expect(await drainProvisionCancellations(dispose)).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
  });
});
