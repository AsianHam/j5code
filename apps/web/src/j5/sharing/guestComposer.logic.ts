import type { ProviderApprovalOption } from "@t3tools/contracts";

/** What a guest is told when they try to attach a file or an image. */
export const GUEST_NO_ATTACHMENTS = "A guest cannot send attachments yet.";

// The server takes these three from a guest and refuses "for this session" and "always".
const GUEST_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

/**
 * The answers an approval offers. A member gets what the provider listed, untouched (`undefined`
 * leaves upstream's own default list in place). A guest approves or declines this one request: a
 * member decides anything that lasts longer (Shared conversations AC8).
 */
export function approvalOptionsFor(
  isGuest: boolean,
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
): ReadonlyArray<ProviderApprovalOption> | undefined {
  if (!isGuest) return options;
  const allowed = new Set<string>(GUEST_APPROVAL_OPTIONS.map((option) => option.decision));
  const listed = (options ?? GUEST_APPROVAL_OPTIONS).filter((option) =>
    allowed.has(option.decision),
  );
  return listed.length === 0 ? GUEST_APPROVAL_OPTIONS : listed;
}
