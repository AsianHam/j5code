import { useEffect, useRef } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { renewPrimarySession } from "./sessionRenewal";

/** How many times one drop of the connection is renewed: when it drops, and once more after. */
const ATTEMPTS_PER_DROP = 2;

/**
 * Renews the primary server's session when its connection drops because J5 ended the session
 * for a change of level, and reloads the page once on the new one, which is the reconnect the
 * person sees (People and access AC17). A device whose session was ended for good, because its
 * person was removed or it was ended, is sent the way upstream sends a browser with no session:
 * to pair. The first try can reach the server before the change that ended the session has
 * committed, so the next refused phase tries once more; and a reload that renewal refused goes
 * through the sign-in gate, which asks again. A drop for any other reason finds the session live,
 * and nothing happens.
 * Mounted once, beside J5's dialogs.
 */
export function SessionRenewalWatcher() {
  const phase = usePrimaryEnvironment()?.connection.phase ?? null;
  const attempts = useRef<number | null>(null);
  useEffect(() => {
    if (phase === "connected") {
      attempts.current = 0;
      return;
    }
    if (attempts.current === null || attempts.current >= ATTEMPTS_PER_DROP) return;
    if (phase !== "reconnecting" && phase !== "error") return;
    attempts.current += 1;
    // Renewed, the page reloads on the new session. Refused, it reloads too, and upstream's
    // sign-in gate then finds no session and sends the browser to pair, so nothing it showed
    // stays on screen (AC49).
    void renewPrimarySession().then((outcome) => {
      if (outcome === "renewed" || outcome === "refused") window.location.reload();
    });
  }, [phase]);
  return null;
}
