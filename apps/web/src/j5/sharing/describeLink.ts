import { J5_LINK_DESCRIBE_PATH } from "@t3tools/contracts/j5";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { DESCRIBE_TIMEOUT_MS } from "./joinPage.logic";
import { renewPrimarySession } from "./sessionRenewal";

/**
 * Asks the server what a link opens and what this browser already is there; `status` is `null`
 * when it could not be asked or did not answer in time. The server reads the cookie to tell who
 * the browser is, so a session J5 ended for a change of level is renewed first: the app renews it
 * as it loads, but not on the pairing page, and the person would otherwise be asked for a name
 * that is already theirs.
 */
export async function describeLink(
  token: string,
): Promise<{ readonly status: number | null; readonly body: unknown }> {
  await renewPrimarySession(AbortSignal.timeout(DESCRIBE_TIMEOUT_MS));
  try {
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl(J5_LINK_DESCRIBE_PATH), {
      method: "POST",
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
  } catch {
    return { status: null, body: null };
  }
}
