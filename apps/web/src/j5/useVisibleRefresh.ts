import { useEffect, useRef } from "react";

function startVisibleRefresh(refresh: () => void, intervalMs: number | null) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastRefresh = Date.now();
  const refreshVisible = () => {
    if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 1_000) return;
    lastRefresh = Date.now();
    refresh();
  };
  const syncTimer = () => {
    clearInterval(timer);
    timer =
      document.visibilityState === "visible" && intervalMs !== null
        ? setInterval(refreshVisible, intervalMs)
        : undefined;
  };
  const onVisibility = () => {
    refreshVisible();
    syncTimer();
  };
  syncTimer();
  window.addEventListener("focus", refreshVisible);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", refreshVisible);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Per-query refresh: null pauses polling; disabled also pauses focus and change refreshes. */
export function useVisibleRefresh(
  refresh: () => void,
  intervalMs: number | null,
  enabled = true,
  refreshKey?: string,
) {
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (enabled) return startVisibleRefresh(refresh, intervalMs);
  }, [refresh, intervalMs, enabled]);
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
        stop = startVisibleRefresh(refresh, null);
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
