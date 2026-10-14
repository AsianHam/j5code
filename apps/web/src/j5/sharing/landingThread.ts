import type { ThreadId } from "@t3tools/contracts";

// The thread a guest was just given by joining an open link as themselves (#614). The join page
// cannot open it directly: the app may first draw from a cached thread list that predates the
// grant, and upstream's thread page leaves an address its list does not hold. So the join page
// leaves it here, in the tab's own storage, and the guest's first screen opens it once the
// server's list holds it.
const KEY = "j5:sharing:landing-thread";

export function rememberLandingThread(threadId: string): void {
  try {
    window.sessionStorage.setItem(KEY, threadId);
  } catch {
    // Storage that cannot be written leaves the guest on their list of what is shared.
  }
}

export function landingThread(): ThreadId | null {
  try {
    return window.sessionStorage.getItem(KEY) as ThreadId | null;
  } catch {
    return null;
  }
}

export function forgetLandingThread(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was kept.
  }
}
