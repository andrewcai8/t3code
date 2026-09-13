import { act, StrictMode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { ProvisionedEnvironmentRecovery } from "./provisionedEnvironmentRecovery";
import { useReconnectSend } from "./useReconnectSend";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let complete = (_result: ProvisionedEnvironmentRecovery) => {};
  const recovery = new Promise<ProvisionedEnvironmentRecovery>((resolve) => {
    complete = resolve;
  });
  let latest: ReturnType<typeof useReconnectSend<string>> | undefined;
  const sent: string[] = [];
  const failures: string[] = [];
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
  it("does not send to a different route when the user navigates during recovery", async () => {
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
