import { act, StrictMode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { type ReconnectResult, useReconnectSend } from "./useReconnectSend";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let complete = (_result: ReconnectResult) => {};
  const recovery = new Promise<ReconnectResult>((resolve) => {
    complete = resolve;
  });
  let latest: ReturnType<typeof useReconnectSend<string>> | undefined;
  const sent: string[] = [];
  const failures: string[] = [];
  const abandoned: string[] = [];
  const recover = vi.fn(() => recovery);
  let threadKey = "original";
  let ready = false;
  let draft = "hello from the retained draft";
  function Composer() {
    const snapshotDraft = draft;
    const snapshotThread = threadKey;
    const action = useReconnectSend({
      threadKey,
      ready,
      recover,
      send: (intent: string) => {
        if (!action.isPending()) sent.push(`${snapshotThread}/${intent}/${snapshotDraft}`);
      },
      onFailure: (message) => failures.push(message),
      onAbandoned: () => abandoned.push(snapshotThread),
    });
    useLayoutEffect(() => {
      latest = action;
    });
    return null;
  }
  await act(() => {
    renderer = create(
      <StrictMode>
        <Composer />
      </StrictMode>,
    );
  });
  return {
    sent,
    failures,
    abandoned,
    cancel: () => {
      if (!latest) throw new Error("Composer did not mount");
      latest.cancel();
    },
    reconnecting: () => latest?.reconnecting ?? false,
    recover,
    complete,
    request: () => {
      if (!latest) throw new Error("Composer did not mount");
      return latest.reconnectAndSend(EnvironmentId.make("child"), "foreground");
    },
    render: async (next: { threadKey?: string; ready?: boolean; draft?: string }) => {
      threadKey = next.threadKey ?? threadKey;
      ready = next.ready ?? ready;
      draft = next.draft ?? draft;
      await act(() => {
        renderer?.update(
          <StrictMode>
            <Composer />
          </StrictMode>,
        );
      });
    },
  };
}

describe("send after reconnect", () => {
  it("uses the current ready render and retained draft, sending once after repeated clicks", async () => {
    const state = await setup();
    let pending: Promise<void> | undefined;
    await act(() => {
      pending = state.request();
      void state.request();
    });
    expect(state.recover).toHaveBeenCalledTimes(1);
    await act(async () => {
      state.complete({ kind: "ready" });
      await pending;
    });
    expect(state.sent).toEqual([]);
    await state.render({ ready: true });
    expect(state.sent).toEqual(["original/foreground/hello from the retained draft"]);
    await state.render({ draft: "next draft" });
    expect(state.sent).toEqual(["original/foreground/hello from the retained draft"]);
  });
  it("does not send to a different route when the user navigates during recovery, and says the message stayed", async () => {
    const state = await setup();
    let pending: Promise<void> | undefined;
    await act(() => {
      pending = state.request();
    });
    await state.render({ threadKey: "other", draft: "another thread", ready: true });
    await act(async () => {
      state.complete({ kind: "ready" });
      await pending;
    });
    expect(state.sent).toEqual([]);
    expect(state.failures).toEqual([]);
    expect(state.abandoned).toEqual(["other"]);
  });
  it("cancels a send that waits on a reconnect, leaving the draft unsent", async () => {
    const state = await setup();
    let pending: Promise<void> | undefined;
    await act(() => {
      pending = state.request();
    });
    expect(state.reconnecting()).toBe(true);
    await act(() => state.cancel());
    expect(state.reconnecting()).toBe(false);
    await act(async () => {
      state.complete({ kind: "ready" });
      await pending;
    });
    await state.render({ ready: true });
    expect(state.sent).toEqual([]);
    expect(state.failures).toEqual([]);
    expect(state.abandoned).toEqual([]);
  });
  it("retains the draft on failure without dispatching a turn", async () => {
    const state = await setup();
    let pending: Promise<void> | undefined;
    await act(() => {
      pending = state.request();
    });
    await act(async () => {
      state.complete({ kind: "failed", message: "Workspace unavailable" });
      await pending;
    });
    await state.render({ ready: true });
    expect(state.sent).toEqual([]);
    expect(state.failures).toEqual(["Workspace unavailable"]);
  });
});
