import { useEffect, useRef } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { renewPrimarySession } from "./sessionRenewal";

/**
 * Renews the primary server's session when its connection drops because J5 ended the session
 * for a change of level, and reloads the page once on the new one, which is the reconnect the
 * person sees (People and access AC17). A drop for any other reason finds the session live, and
 * nothing happens. Mounted once, beside J5's dialogs.
 */
export function SessionRenewalWatcher() {
  const phase = usePrimaryEnvironment()?.connection.phase ?? null;
  const wasConnected = useRef(false);
  useEffect(() => {
    if (phase === "connected") {
      wasConnected.current = true;
      return;
    }
    if (!wasConnected.current || (phase !== "reconnecting" && phase !== "error")) return;
    wasConnected.current = false;
    void renewPrimarySession().then((renewed) => {
      if (renewed) window.location.reload();
    });
  }, [phase]);
  return null;
}
