import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { sendAfterReconnect } from "./sendAfterReconnect";

const RECONNECT_WAIT_MS = 15_000;

/**
 * Watches the environment's sessions from now on. The connection phase can still read "connected"
 * while a resume replaces the session, so a new session, not the phase, is the sign to send again.
 */
export function watchEnvironmentSessions(environmentId: EnvironmentId) {
  const generationAtom = environmentCatalog.sessionGenerationAtom(environmentId);
  const listeners = new Set<() => void>();
  // The subscription keeps the count mounted, so it keeps counting until disposed.
  const unsubscribe = appAtomRegistry.subscribe(generationAtom, () => {
    for (const listener of listeners) listener();
  });
  const baseline = appAtomRegistry.get(generationAtom);
  const hasNewSession = () => appAtomRegistry.get(generationAtom) > baseline;
  return {
    /** Resolves true once a session newer than the one at the start is up, false after the wait. */
    waitForNewSession: (): Promise<boolean> => {
      if (hasNewSession()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const finish = (value: boolean) => {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(value);
        };
        const check = () => {
          if (hasNewSession()) finish(true);
        };
        const timer = setTimeout(() => finish(false), RECONNECT_WAIT_MS);
        listeners.add(check);
      });
    },
    dispose: unsubscribe,
  };
}

/** Sends once, and once more after a new session if the first send found none (`sendAfterReconnect`). */
export async function sendWhenReconnected<A>(
  environmentId: EnvironmentId,
  send: () => Promise<A>,
): Promise<A> {
  const sessions = watchEnvironmentSessions(environmentId);
  try {
    return await sendAfterReconnect({ send, waitForReconnect: sessions.waitForNewSession });
  } finally {
    sessions.dispose();
  }
}
