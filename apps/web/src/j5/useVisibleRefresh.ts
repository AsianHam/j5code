import { useEffect, useRef } from "react";

/** Refreshes when the tab is focused or shown again, at most once a second. No timer. */
function startVisibleRefresh(refresh: () => void) {
  let lastRefresh = Date.now();
  const refreshVisible = () => {
    if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 1_000) return;
    lastRefresh = Date.now();
    refresh();
  };
  window.addEventListener("focus", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
  return () => {
    window.removeEventListener("focus", refreshVisible);
    document.removeEventListener("visibilitychange", refreshVisible);
  };
}

/**
 * Per-query refresh: when the tab is focused or shown again, and when `refreshKey` changes while
 * it is visible. Disabled pauses both.
 */
export function useVisibleRefresh(refresh: () => void, enabled = true, refreshKey?: string) {
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (enabled) return startVisibleRefresh(refresh);
  }, [refresh, enabled]);
  useEffect(() => {
    if (!enabled || lastKey.current === refreshKey || document.visibilityState !== "visible")
      return;
    lastKey.current = refreshKey;
    refresh();
  }, [refresh, enabled, refreshKey]);
}

/**
 * A refresh when the tab is focused or shown again, shared by a feature's consumers so another one
 * costs no extra read. No timer: these reads follow the server's change stream, and this covers
 * what that stream has no signal for.
 */
export function createVisibleRefreshHook(refresh: () => void) {
  let consumers = 0;
  let stop: (() => void) | undefined;
  return function useVisibleRefresh() {
    useEffect(() => {
      consumers += 1;
      if (consumers === 1) {
        stop = startVisibleRefresh(refresh);
      }
      return () => {
        consumers -= 1;
        if (consumers === 0) {
          stop?.();
          stop = undefined;
        }
      };
    }, []);
  };
}
