import { J5_SESSION_RENEW_PATH } from "@t3tools/contracts/j5";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

/**
 * Asks the primary server to renew this browser's session, when J5 ended it because its person's
 * level or scope changed (People and access AC17). The browser's cookie carries the old session,
 * which still proves which one it was; the new session comes back as the cookie. `true` only when
 * a new session was issued; a live session, a device that was ended, and any failure are `false`,
 * and the person is then sent to pair as upstream sends them.
 */
export async function renewPrimarySession(): Promise<boolean> {
  try {
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl(J5_SESSION_RENEW_PATH), {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "renewed" in body && body.renewed === true;
  } catch {
    return false;
  }
}
