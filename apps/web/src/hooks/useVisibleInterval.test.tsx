import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useVisibleInterval } from "./useVisibleInterval";

let renderer: ReactTestRenderer;
let calls = 0;
const page = Object.assign(new EventTarget(), { visibilityState: "visible" });

function setVisibility(state: "visible" | "hidden") {
  page.visibilityState = state;
  page.dispatchEvent(new Event("visibilitychange"));
}

function Probe({ enabled }: { enabled: boolean }) {
  useVisibleInterval(() => (calls += 1), 1_000, enabled);
  return null;
}

beforeEach(() => {
  calls = 0;
  page.visibilityState = "visible";
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", page);
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("ticks while visible, stops while hidden, and catches up once on return", () => {
  act(() => {
    renderer = create(<Probe enabled />);
  });
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
  act(() => {
    renderer = create(<Probe enabled={false} />);
  });
  act(() => vi.advanceTimersByTime(3_000));
  act(() => setVisibility("visible"));
  expect(calls).toBe(0);
  act(() => renderer.update(<Probe enabled />));
  act(() => vi.advanceTimersByTime(1_000));
  expect(calls).toBe(1);
});
