import { SCHEDULED_TASK_MESSAGE_ID_PREFIX } from "@t3tools/contracts";
import type { ChatMessage } from "../../types";
import { isSharedNote } from "../sharing/sharedTimeline.logic";

/**
 * Automated user-role messages (A2A deliveries, scheduled task fires, delegated-task completions,
 * restart continuations, system nudges) and a shared conversation's note would crowd the minimap
 * on long-running agent threads. A2A deliveries carry the sender's actor in createdBy, so only
 * scheduled task fires need an id check: they inherit the task creator's actor.
 */
export function isHumanAuthoredUserMessage(message: ChatMessage): boolean {
  if (message.role !== "user" || isSharedNote(message)) return false;
  if (message.createdBy !== undefined && message.createdBy !== "user") return false;
  return !String(message.id).startsWith(SCHEDULED_TASK_MESSAGE_ID_PREFIX);
}
