import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `ms` while the page is visible, and once each time it becomes visible
 * again, so a hidden tab costs nothing and catches up with one call when it returns.
 */
export function useVisibleInterval(callback: () => void, ms: number, enabled: boolean): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      timer = setInterval(() => latest.current(), ms);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") latest.current();
      sync();
    };
    sync();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, ms]);
}
