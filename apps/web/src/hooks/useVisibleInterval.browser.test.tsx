import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { useVisibleInterval } from "./useVisibleInterval";

function Probe({ enabled, onTick }: { enabled: boolean; onTick: () => void }) {
  useVisibleInterval(onTick, 1_000, enabled);
  return null;
}

function stubVisibility() {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  return {
    set(state: DocumentVisibilityState) {
      visibility = state;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    [Symbol.dispose]() {
      Reflect.deleteProperty(document, "visibilityState");
    },
  };
}

it("ticks while visible, stops while hidden, and catches up once on return", async () => {
  using _timers = fakeTimers();
  using visibility = stubVisibility();
  const onTick = vi.fn();
  await using _screen = await render(<Probe enabled onTick={onTick} />, { router: false });
  await act(() => vi.advanceTimersByTime(3_000));
  expect(onTick).toHaveBeenCalledTimes(3);
  await act(() => visibility.set("hidden"));
  await act(() => vi.advanceTimersByTime(10_000));
  expect(onTick).toHaveBeenCalledTimes(3);
  await act(() => visibility.set("visible"));
  expect(onTick).toHaveBeenCalledTimes(4);
  await act(() => vi.advanceTimersByTime(1_000));
  expect(onTick).toHaveBeenCalledTimes(5);
});

it("does nothing while disabled", async () => {
  using _timers = fakeTimers();
  using visibility = stubVisibility();
  const onTick = vi.fn();
  await using screen = await render(<Probe enabled={false} onTick={onTick} />, { router: false });
  await act(() => vi.advanceTimersByTime(3_000));
  await act(() => visibility.set("visible"));
  expect(onTick).toHaveBeenCalledTimes(0);
  await screen.rerender(<Probe enabled onTick={onTick} />);
  await act(() => vi.advanceTimersByTime(1_000));
  expect(onTick).toHaveBeenCalledTimes(1);
});
