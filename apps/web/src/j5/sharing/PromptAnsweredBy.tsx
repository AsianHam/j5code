import { answeredBy } from "./sharedConversation.logic";
import { usePromptAnswer } from "./sharedTimeline";

/**
 * Who answered one of the agent's prompts in a shared conversation, after the prompt's own line:
 * "· answered by Priya". It draws nothing for a prompt nobody is recorded as answering, which is
 * every prompt of a thread that is not shared.
 */
export function PromptAnsweredBy({ toolData }: { readonly toolData: unknown }) {
  const item = toolData as { readonly type?: unknown; readonly requestId?: unknown } | undefined;
  const answer = usePromptAnswer(
    (item?.type === "approval_request" || item?.type === "user_input_request") &&
      typeof item.requestId === "string"
      ? item.requestId
      : null,
  );
  if (answer === undefined) return null;
  return (
    <span className="shrink-0 text-muted-foreground" data-j5-shared-conversation="answered-by">
      · answered by {answer.you ? "you" : answeredBy(answer)}
    </span>
  );
}
