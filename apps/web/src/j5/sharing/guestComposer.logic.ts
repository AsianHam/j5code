import type { ProviderApprovalOption } from "@t3tools/contracts";

/** What a guest is told when they try to send more than text. */
export const GUEST_TEXT_ONLY =
  "A guest can send text only: no attachments, mentions or other context.";

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

/**
 * What a guest's command to change a queued message of their own carries: the text. The server
 * refuses a guest's attachments and context, which upstream's edit always sends. A member's
 * command is returned as it is.
 */
export function queuedEditFor<Input extends { readonly edit?: unknown }>(
  isGuest: boolean,
  input: Input,
): Input {
  if (!isGuest || input.edit === undefined) return input;
  const { edit: _edit, ...textOnly } = input;
  return textOnly as Input;
}
