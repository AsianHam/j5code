import { useEffect, useRef } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { renewPrimarySession } from "./sessionRenewal";

/** How many times one drop of the connection is renewed: when it drops, and once more after. */
const ATTEMPTS_PER_DROP = 2;

/**
 * A session J5 ended for a change of level is renewed and the page reloads once (People and access
 * AC17); one ended for good is sent to pair, as upstream does. The first try can reach the server
 * before the change that ended the session commits, so the next refused phase tries once more.
 * Mounted once, beside J5's dialogs.
 */
export function SessionRenewalWatcher() {
  const phase = usePrimaryEnvironment()?.connection.phase ?? null;
  const attempts = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- renews the session in response to the connection dropping, which no handler here causes.
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
