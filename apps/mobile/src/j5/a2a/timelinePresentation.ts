import type { ParticipantIdentities } from "@t3tools/client-runtime/j5/participant-identity";
import {
  isJ5DeliveryMessage,
  presentJ5UserMessage,
  resolveJ5UserMessagePresentation,
  type J5UserMessageInput,
} from "@t3tools/client-runtime/j5/user-message";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MessageAuthor } from "@t3tools/contracts/j5";

/**
 * What every J5 row in one thread's timeline reads: the reader, the identity read's names, and
 * who sent each message of a shared conversation.
 */
export interface J5Timeline extends ParticipantIdentities {
  readonly environmentId: EnvironmentId;
  readonly viewerParticipantId: string | null;
  readonly sharedAuthors: ReadonlyMap<string, MessageAuthor>;
}

/**
 * Upstream's user-message presentation with J5's reading on top (the shared classifier): the
 * letter without its envelope, `"agent"` for every participant so it folds, which side it sits
 * on, and the folded row's preview where J5 read the message.
 */
export function resolveJ5FeedMessage(message: J5UserMessageInput, timeline: J5Timeline) {
  const presentation = resolveJ5UserMessagePresentation(message, {
    viewerParticipantId: timeline.viewerParticipantId,
  });
  const j5 = presentation.j5;
  const sharedAuthor =
    j5?.group === "person" && !j5.viaInbox && message.id !== undefined
      ? timeline.sharedAuthors.get(String(message.id))
      : undefined;
  return {
    ...presentation,
    // Another person's message in a shared conversation sits on the left, named (AC16).
    sharedAuthor,
    side: sharedAuthor !== undefined && !sharedAuthor.you ? "left" : (j5?.side ?? "right"),
    preview: j5?.group === "participant" && j5.unwrapped ? j5.preview : null,
  };
}

export type J5FeedMessagePresentation = ReturnType<typeof resolveJ5FeedMessage>;

/**
 * J5's platform notices that upstream's row would draw as the reader's own message: a silence,
 * which has a plain summary, and a Crew notice or a delivery notice this client cannot read yet,
 * which keep their raw text until the notices are redrawn. Null for every other message.
 */
export function presentJ5TimelineNotice(
  message: J5UserMessageInput,
):
  | { readonly kind: "silence"; readonly summary: string | null }
  | { readonly kind: "raw"; readonly label: string }
  | null {
  if (message.role !== "user" || message.createdBy !== "system") return null;
  const presentation = presentJ5UserMessage(message);
  if (presentation?.group !== "notice") {
    return isJ5DeliveryMessage(message) ? { kind: "raw", label: "Raw A2A delivery" } : null;
  }
  if (presentation.kind === "silence") return { kind: "silence", summary: presentation.summary };
  if (presentation.kind === "crew-gate" || presentation.kind === "crew-seats") {
    return { kind: "raw", label: "Crew notice" };
  }
  return isJ5DeliveryMessage(message) ? { kind: "raw", label: "Raw A2A delivery" } : null;
}
