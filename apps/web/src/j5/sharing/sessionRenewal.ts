import { J5_SESSION_RENEW_PATH } from "@t3tools/contracts/j5";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

/**
 * `renewed`: J5 ended the session for a change of level and the new one is the cookie now. `live`:
 * it was never ended. `refused`: it was ended for good (device removed or ended, or expired), so
 * the browser pairs again. `unknown`: the server could not be asked or did not say.
 */
export type PrimarySessionRenewal = "renewed" | "live" | "refused" | "unknown";

/** Asks the primary server to renew this browser's session (People and access AC17). */
export async function renewPrimarySession(signal?: AbortSignal): Promise<PrimarySessionRenewal> {
  try {
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl(J5_SESSION_RENEW_PATH), {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
      credentials: "include",
    });
    if (response.status === 401) return "refused";
    if (!response.ok) return "unknown";
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("renewed" in body)) return "unknown";
    return body.renewed === true ? "renewed" : "live";
  } catch {
    return "unknown";
  }
}
