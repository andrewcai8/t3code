import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useVisibleInterval } from "./useVisibleInterval";

let root: Root;
let calls = 0;
let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

function Probe({ enabled }: { enabled: boolean }) {
  useVisibleInterval(() => (calls += 1), 1_000, enabled);
  return null;
}

beforeEach(() => {
  calls = 0;
  visibility = "visible";
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

it("ticks while visible, stops while hidden, and catches up once on return", () => {
  act(() => root.render(<Probe enabled />));
  act(() => vi.advanceTimersByTime(3_000));
  expect(calls).toBe(3);
  act(() => setVisibility("hidden"));
  act(() => vi.advanceTimersByTime(10_000));
  expect(calls).toBe(3);
  act(() => setVisibility("visible"));
  expect(calls).toBe(4);
  act(() => vi.advanceTimersByTime(1_000));
  expect(calls).toBe(5);
});

it("does nothing while disabled", () => {
  act(() => root.render(<Probe enabled={false} />));
  act(() => vi.advanceTimersByTime(3_000));
  act(() => setVisibility("visible"));
  expect(calls).toBe(0);
  act(() => root.render(<Probe enabled />));
  act(() => vi.advanceTimersByTime(1_000));
  expect(calls).toBe(1);
});
