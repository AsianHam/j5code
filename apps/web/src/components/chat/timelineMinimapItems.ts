import { SCHEDULED_TASK_MESSAGE_ID_PREFIX } from "@t3tools/contracts";
import type { ChatMessage } from "../../types";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

/**
 * J5: the minimap indexes what the person sent, including Inbox replies.
 * Automated user-role messages — peer and machine A2A deliveries, scheduled
 * task fires, delegated-task completions, restart continuations, and system
 * nudges — still render in the timeline but would otherwise crowd the rail on
 * long-running agent threads. A2A deliveries carry the sender's actor in
 * createdBy, so only scheduled task fires need an id check: they inherit the
 * task creator's actor.
 */
export function isHumanAuthoredUserMessage(message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  if (message.createdBy !== undefined && message.createdBy !== "user") return false;
  return !String(message.id).startsWith(SCHEDULED_TASK_MESSAGE_ID_PREFIX);
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || !isHumanAuthoredUserMessage(row.message)) {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: compactMinimapPreview(item.userText),
        assistantText: compactMinimapPreview(item.assistantText),
      };
}
