import {
  PEER_PROTOCOL_HEADER,
  PEER_PROTOCOL_VERSION,
  type PeerCapabilities,
} from "@t3tools/contracts/j5";

/** What this server tells every peer it can do, in a hello and in both directions of a poll. */
export const ownPeerCapabilities = { poll: true, landing: true } satisfies PeerCapabilities;

/**
 * The one compare for both directions of peering. A server states its peer
 * protocol version on every request it sends and every response it answers,
 * and each side checks what the other stated here, so a mismatch is caught
 * whichever server was updated. A missing header is a server from before
 * versioning, which counts as version 1, except on a response that failed.
 */

/** The header this server sends on every peer request and response. */
export const peerProtocolHeaders = { [PEER_PROTOCOL_HEADER]: String(PEER_PROTOCOL_VERSION) };

/**
 * Null when the stated version matches this server's; otherwise the reason,
 * naming which server to update. `stated` is what the other server said, from
 * a header or a hello body; a server that said nothing counts as version 1.
 * Only a whole number is a version: anything else is the other server's fault,
 * and the reason never repeats what it sent.
 */
export const peerProtocolMismatch = (input: {
  readonly stated: string | number | undefined;
  /** How this server names the other one in the reason. */
  readonly peer: string;
  /** This server's version; tests state another to model a protocol bump. */
  readonly ours?: number;
}): string | null => {
  const ours = input.ours ?? PEER_PROTOCOL_VERSION;
  const stated = input.stated ?? 1;
  const version =
    typeof stated === "number"
      ? Number.isSafeInteger(stated)
        ? stated
        : null
      : /^\d+$/.test(stated)
        ? Number(stated)
        : null;
  if (version === null) {
    return `${input.peer} sent an unreadable peer protocol version. Update J5 on ${input.peer}, then try again.`;
  }
  if (version === ours) return null;
  // The other server is named at the start of the sentence only: some callers name it with a phrase.
  const where = version < ours ? "there" : "on this server";
  return `${input.peer} runs peer protocol ${String(version)} and this server runs ${String(ours)}. Update J5 ${where}, then try again.`;
};

/**
 * The mismatch a peer's response states, read before its status. A response
 * with no header counts as version 1 only when it succeeded: an error answer
 * without one, such as a proxy's 502, an unhandled 500 or a server that is not
 * J5, is left to its status, so it never reads as a server to update. A real
 * mismatch is refused with the header, so it is still caught.
 */
export const responseProtocolMismatch = (input: {
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string | undefined>>;
  };
  readonly peer: string;
  readonly ours?: number;
}): string | null => {
  const stated = statedPeerProtocol(input.response.headers);
  const succeeded = input.response.status >= 200 && input.response.status < 300;
  if (stated === undefined && !succeeded) return null;
  return peerProtocolMismatch({
    stated,
    peer: input.peer,
    ...(input.ours === undefined ? {} : { ours: input.ours }),
  });
};

/** The version a peer request or response states in its header. */
export const statedPeerProtocol = (headers: Readonly<Record<string, string | undefined>>) =>
  headers[PEER_PROTOCOL_HEADER];
