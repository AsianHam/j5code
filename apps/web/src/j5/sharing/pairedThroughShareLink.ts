import { useSyncExternalStore } from "react";

// Whether this browser was last paired to its server through a share link. It is one flag in the
// browser's own storage, which is already per server: a browser reaches one server per origin.
// It decides nothing about access. It only lets the first screen wait for the server to say the
// connection is a guest's, instead of starting a draft a guest could not send or offering them
// the setup a member gets on a new server.
const KEY = "j5:sharing:paired-through-share-link";

const listeners = new Set<() => void>();

export function wasPairedThroughShareLink(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberPairedThroughShareLink(paired: boolean): void {
  try {
    if (paired) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage that cannot be written costs a guest one draft screen, which the server refuses.
  }
  for (const listener of listeners) listener();
}

/**
 * Pairs this browser with a share link's credential, and remembers that it did only once the
 * server has accepted it. A link the server refuses, such as a guest's link opened by a signed-in
 * member, leaves the browser as it was: still a member's, with upstream's first screen.
 */
export async function pairThroughShareLink(
  credential: string,
  submit: (credential: string) => Promise<unknown>,
): Promise<void> {
  await submit(credential);
  rememberPairedThroughShareLink(true);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Whether a signed-in browser is offered first-run setup. A browser never paired through a share
 * link gets upstream's answer. One that was is a guest's until the server says otherwise, and a
 * guest has no server to set up; when the server says "member" the flag clears and setup is
 * offered again. A person who is a guest here and a member of another connected server is
 * offered it as upstream would, for the server that is theirs: only someone who is a guest
 * everywhere is passed over.
 */
export const firstRunSetupOffered = (input: {
  readonly authenticated: boolean;
  readonly pairedThroughShareLink: boolean;
  readonly memberSomewhere: boolean;
}) => input.authenticated && (!input.pairedThroughShareLink || input.memberSomewhere);

/** The remembered flag, read again whenever it is written. */
export function usePairedThroughShareLink(): boolean {
  return useSyncExternalStore(subscribe, wasPairedThroughShareLink, () => false);
}
