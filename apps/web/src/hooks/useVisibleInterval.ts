import { useEffect, useEffectEvent } from "react";

/**
 * Calls `callback` every `ms` while the page is visible, and once each time it becomes visible
 * again, so a hidden tab costs nothing and catches up with one call when it returns.
 */
export function useVisibleInterval(callback: () => void, ms: number, enabled: boolean): void {
  const tick = useEffectEvent(callback);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      timer = setInterval(() => tick(), ms);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
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
