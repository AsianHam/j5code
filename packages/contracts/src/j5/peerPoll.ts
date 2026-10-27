/**
 * Online and offline for a peer in poll mode, read the same way by every
 * surface that shows it. A poller polls at least every half-minute while it
 * runs, so a peer is online while it polled within this window, and offline
 * since its last poll after that.
 */
export const PEER_ONLINE_WINDOW_MS = 2 * 60_000;

/** Online, offline since, or never polled, for a peer in poll mode; null for one that sends directly. */
export const peerPollState = (
  peer: { readonly linkMode: "push" | "store" | "poll"; readonly lastPolledAt: string | null },
  nowMs: number,
):
  | { readonly kind: "online"; readonly lastPolledAt: string }
  | { readonly kind: "offline"; readonly since: string }
  | { readonly kind: "never" }
  | null => {
  if (peer.linkMode === "push") return null;
  if (peer.lastPolledAt === null) return { kind: "never" };
  return nowMs - Date.parse(peer.lastPolledAt) <= PEER_ONLINE_WINDOW_MS
    ? { kind: "online", lastPolledAt: peer.lastPolledAt }
    : { kind: "offline", since: peer.lastPolledAt };
};

const CREDENTIAL_REJECTED = "rejected this server's credential (HTTP 401): it ended this peering.";

/**
 * The reason recorded when a peer rejects the credential it issued, which it
 * does only once it has removed this server: a poller stops polling on it, and
 * a server that sends directly records it from a send or an address-book read.
 */
export const peerCredentialRejectedReason = (label: string) => `${label} ${CREDENTIAL_REJECTED}`;

/** The mark a poller puts on the peer's last error when it stops polling. */
export const PEER_POLL_STOPPED_PREFIX = "Polling stopped: ";
const POLLING_STOPPED = PEER_POLL_STOPPED_PREFIX;

/** What a poller records when it stops polling, which only peering again or an update restarts. */
export const peerPollStoppedError = (reason: string) => `${POLLING_STOPPED}${reason}`;

/**
 * Why polling stopped, from what the poller recorded when it stopped; null
 * while it polls, after a failure it retries, and for a peer that does not poll.
 */
export const peerPollStoppedReason = (peer: {
  readonly linkMode: "push" | "store" | "poll";
  readonly lastError: string | null;
}) =>
  peer.linkMode === "poll" && peer.lastError?.startsWith(POLLING_STOPPED) === true
    ? peer.lastError.slice(POLLING_STOPPED.length)
    : null;

/**
 * Whether the other server ended this peering by rejecting the credential it issued. A poller
 * reads it from its stop, so a retried failure quoting the same words is not one; a direct sender
 * reads its last recorded rejection, which a later success clears. What is left is removing it.
 */
export const isPeerCredentialRejected = (peer: {
  readonly linkMode: "push" | "store" | "poll";
  readonly lastError: string | null;
}) =>
  peer.linkMode === "poll"
    ? peerPollStoppedReason(peer)?.endsWith(CREDENTIAL_REJECTED) === true
    : peer.linkMode === "push" && peer.lastError?.endsWith(CREDENTIAL_REJECTED) === true;
