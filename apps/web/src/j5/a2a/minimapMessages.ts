import { SCHEDULED_TASK_MESSAGE_ID_PREFIX } from "@t3tools/contracts";
import type { ChatMessage } from "../../types";

/**
 * The minimap indexes what the person sent, including Inbox replies.
 * Automated user-role messages (peer and machine A2A deliveries, scheduled
 * task fires, delegated-task completions, restart continuations, and system
 * nudges) still render in the timeline but would otherwise crowd the rail on
 * long-running agent threads. A2A deliveries carry the sender's actor in
 * createdBy, so only scheduled task fires need an id check: they inherit the
 * task creator's actor.
 */
export function isHumanAuthoredUserMessage(message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  if (message.createdBy !== undefined && message.createdBy !== "user") return false;
  return !String(message.id).startsWith(SCHEDULED_TASK_MESSAGE_ID_PREFIX);
}
