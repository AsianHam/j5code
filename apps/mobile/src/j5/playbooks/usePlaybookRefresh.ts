import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/**
 * Refreshes the playbook read when the screen is focused, when the app returns to the foreground,
 * and when `refreshKey` changes: the server's playbook revision, which a run and the YAML of an
 * active run both move, and the thread's turn. No timer.
 */
export function usePlaybookRefresh(input: {
  focused: boolean;
  connected: boolean;
  supported: boolean;
  isPending: boolean;
  refreshKey: string;
  refresh: () => void;
}) {
  const latest = useRef(input);
  const lastRefreshKey = useRef(input.refreshKey);
  useEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    if (!input.focused || !input.connected || !input.supported) return;
    const refresh = () => {
      if (AppState.currentState === "active" && !latest.current.isPending) {
        lastRefreshKey.current = latest.current.refreshKey;
        latest.current.refresh();
      }
    };
    refresh();
    const subscription = AppState.addEventListener("change", refresh);
    return () => subscription.remove();
  }, [input.focused, input.connected, input.supported]);
  useEffect(() => {
    if (
      !input.focused ||
      !input.connected ||
      !input.supported ||
      input.isPending ||
      AppState.currentState !== "active" ||
      lastRefreshKey.current === input.refreshKey
    )
      return;
    lastRefreshKey.current = input.refreshKey;
    latest.current.refresh();
  }, [input.focused, input.connected, input.supported, input.isPending, input.refreshKey]);
}
