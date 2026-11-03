interface GateLike {
  readonly status: "open" | "approved" | "declined";
  readonly kind: "roster" | "addition";
  readonly captainThreadId: string;
  readonly approvalMode?: "human" | "automatic";
}

/** Initial rosters and legacy addition requests are answered in their Captain's thread. */
export const rosterGatesForThread = <T extends GateLike>(
  proposals: ReadonlyArray<T>,
  threadId: string | null | undefined,
): ReadonlyArray<T> =>
  threadId == null
    ? []
    : proposals.filter(
        (proposal) =>
          proposal.status === "open" &&
          proposal.approvalMode !== "automatic" &&
          proposal.captainThreadId === threadId,
      );
