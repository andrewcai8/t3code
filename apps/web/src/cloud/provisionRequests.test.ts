import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EnvironmentProvisionResult,
  type EnvironmentProvisionInput,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  cancelProvisionRequest,
  drainProvisionCancellations,
  forgetProvisionRequest,
  isProvisionRequestActive,
  pollProvisionRequest,
  PROVISION_IN_PROGRESS_MESSAGE,
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

function readyResult(
  requestId: EnvironmentProvisionInput["requestId"],
): EnvironmentProvisionResult {
  return {
    kind: "ready",
    requestId,
    environment: {
      environmentId: EnvironmentId.make("prepared"),
      leaseId: "lease",
      provider: "e2b",
      sandboxId: "sandbox",
      projectDir: "/workspace",
      providerInstanceId: "codex-account",
      sourceRevision: null,
      t3Revision: "a".repeat(40),
      artifactSha256: "b".repeat(64),
      control: {
        preparationRoot: "/prepared",
        brokerCredentialPath: "/prepared/credential",
        localT3Url: "http://localhost:3773",
        runtimeExecutable: "node",
        runtimeEntrypoint: "/prepared/t3/index.mjs",
      },
    },
  };
}

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
  vi.useRealTimers();
});

describe("draft provisioning requests", () => {
  it("persists the request before dispatch and recovers the exact input on retry", async () => {
    const first = reserveProvisionRequest("draft-1", request);
    expect(first.input.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    expect([...persisted.values()].map((value) => JSON.parse(value))).toEqual([
      { "draft-1": first },
    ]);
    vi.resetModules();
    const reloaded = await import("./provisionRequests");
    expect(reloaded.reserveProvisionRequest("draft-1", request)).toEqual(first);
    expect(reloaded.reserveProvisionRequest("draft-2", request).input.requestId).not.toBe(
      first.input.requestId,
    );
  });

  it("refuses changed intent while preserving the original pending request", () => {
    const first = reserveProvisionRequest("draft-1", request);
    expect(() =>
      reserveProvisionRequest("draft-1", {
        ...request,
        input: { ...request.input, providerInstanceId: "another-account" },
      }),
    ).toThrow("already requested an environment");
    expect(reserveProvisionRequest("draft-1", request)).toEqual(first);
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

  it("forgets a submitted draft without changing another draft's retry identity", () => {
    reserveProvisionRequest("draft-1", request);
    const other = reserveProvisionRequest("draft-2", request);
    expect(forgetProvisionRequest("draft-1")).toBe(true);
    expect([...persisted.values()].map((value) => JSON.parse(value))).toEqual([
      { "draft-2": other },
    ]);
    expect(reserveProvisionRequest("draft-2", request)).toEqual(other);
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

describe("provision request polling and cancellation", () => {
  it("polls pending, ambiguous and transient responses with the exact saved request", async () => {
    vi.useFakeTimers();
    const saved = reserveProvisionRequest("polling-draft", request);
    const results: Array<EnvironmentProvisionResult | null> = [
      { kind: "pending", requestId: saved.input.requestId, message: PROVISION_IN_PROGRESS_MESSAGE },
      {
        kind: "allocation_unknown",
        requestId: saved.input.requestId,
        message: "Checking allocation",
      },
      null,
      readyResult(saved.input.requestId),
    ];
    const dispatch = vi.fn<(input: typeof saved) => Promise<EnvironmentProvisionResult | null>>(
      async () => results.shift() ?? null,
    );
    const result = pollProvisionRequest("polling-draft", saved, dispatch);
    await vi.runAllTimersAsync();
    expect(await result).toEqual(readyResult(saved.input.requestId));
    expect(dispatch.mock.calls).toHaveLength(4);
    for (const [input] of dispatch.mock.calls) expect(input).toEqual(saved);
    expect(reserveProvisionRequest("polling-draft", request)).toEqual(saved);
  });

  it("bounds automatic polling and leaves the same request available for resume", async () => {
    vi.useFakeTimers();
    const saved = reserveProvisionRequest("bounded-draft", request);
    const dispatch = vi.fn(async () => null);
    const result = pollProvisionRequest("bounded-draft", saved, dispatch);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ kind: "unreachable" });
    expect(dispatch).toHaveBeenCalledTimes(60);
    expect(reserveProvisionRequest("bounded-draft", request)).toEqual(saved);
  });

  it("stops polling when preparation reports a lastError instead of retrying for minutes", async () => {
    const saved = reserveProvisionRequest("failed-draft", request);
    const dispatch = vi.fn(async () => ({
      kind: "pending" as const,
      requestId: saved.input.requestId,
      message: "Remote preparation failed: Preparation command timed out: git fetch",
    }));
    await expect(pollProvisionRequest("failed-draft", saved, dispatch)).resolves.toEqual({
      kind: "pending",
      requestId: saved.input.requestId,
      message: "Remote preparation failed: Preparation command timed out: git fetch",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reserveProvisionRequest("failed-draft", request)).toEqual(saved);
  });

  it("stops waiting immediately when the draft is cancelled", async () => {
    vi.useFakeTimers();
    const saved = reserveProvisionRequest("waiting-draft", request);
    const dispatch = vi.fn(async () => ({
      kind: "pending" as const,
      requestId: saved.input.requestId,
      message: PROVISION_IN_PROGRESS_MESSAGE,
    }));
    const result = pollProvisionRequest("waiting-draft", saved, dispatch);
    await vi.advanceTimersByTimeAsync(0);
    cancelProvisionRequest("waiting-draft");
    expect(await result).toEqual({ kind: "cancelled" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a receipt arriving after deletion and retains cancellation until disposal is confirmed", async () => {
    const saved = reserveProvisionRequest("cancelled-draft", request);
    let release: (value: EnvironmentProvisionResult) => void = () => {
      throw new Error("Receipt barrier not initialized");
    };
    const receipt = new Promise<EnvironmentProvisionResult>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(() => receipt);
    const result = pollProvisionRequest("cancelled-draft", saved, dispatch);
    cancelProvisionRequest("cancelled-draft");
    release(readyResult(saved.input.requestId));
    expect(await result).toEqual({ kind: "cancelled" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const observed: Array<unknown> = [];
    expect(
      await drainProvisionCancellations(async (pending) => {
        observed.push({
          manager: pending.managerEnvironmentId,
          requestId: pending.input.requestId,
        });
        return { kind: "refused", reason: "unknown", message: "Allocation still unknown" };
      }),
    ).toEqual([]);
    expect(
      await drainProvisionCancellations(async (pending) => {
        observed.push({
          manager: pending.managerEnvironmentId,
          requestId: pending.input.requestId,
        });
        return { kind: "disposed" };
      }),
    ).toEqual(["cancelled-draft"]);
    expect(observed).toEqual([
      { manager: "manager", requestId: saved.input.requestId },
      { manager: "manager", requestId: saved.input.requestId },
    ]);
    expect([...persisted.values()].map((value) => JSON.parse(value))).toEqual([{}]);
  });

  it("starts a fresh request after cancel while disposing the cancelled one", async () => {
    const saved = reserveProvisionRequest("retry-draft", request);
    cancelProvisionRequest("retry-draft");
    const retried = reserveProvisionRequest("retry-draft", request);
    expect(retried.input.requestId).not.toBe(saved.input.requestId);
    expect(isProvisionRequestActive("retry-draft")).toBe(true);
    const observed: string[] = [];
    expect(
      await drainProvisionCancellations(async (pending) => {
        observed.push(pending.input.requestId);
        return { kind: "disposed" };
      }),
    ).toEqual([]);
    expect(observed).toEqual([saved.input.requestId]);
    expect(isProvisionRequestActive("retry-draft")).toBe(true);
    expect(reserveProvisionRequest("retry-draft", request)).toEqual(retried);
  });

  it("abandons an in-flight poll when a later send replaces the cancelled request", async () => {
    const saved = reserveProvisionRequest("replaced-draft", request);
    let release: (value: EnvironmentProvisionResult) => void = () => {
      throw new Error("Receipt barrier not initialized");
    };
    const receipt = new Promise<EnvironmentProvisionResult>((resolve) => {
      release = resolve;
    });
    const result = pollProvisionRequest("replaced-draft", saved, () => receipt);
    cancelProvisionRequest("replaced-draft");
    const retried = reserveProvisionRequest("replaced-draft", request);
    release(readyResult(saved.input.requestId));
    expect(await result).toEqual({ kind: "cancelled" });
    expect(retried.input.requestId).not.toBe(saved.input.requestId);
  });

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
