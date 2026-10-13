import { answeredBy, isSettledPrompt } from "./sharedConversation.logic";
import { usePromptAnswer } from "./sharedTimeline";

/**
 * Who answered one of the agent's prompts in a shared conversation, after the prompt's own line:
 * "· answered by Priya". It draws nothing for a prompt nobody is recorded as answering, which is
 * every prompt of a thread that is not shared, and nothing for a prompt still open.
 */
export function PromptAnsweredBy({ toolData }: { readonly toolData: unknown }) {
  // Only a settled prompt has an answerer to name.
  const answer = usePromptAnswer(isSettledPrompt(toolData) ? toolData.requestId : null);
  if (answer === undefined) return null;
  return (
    <span className="shrink-0 text-muted-foreground" data-j5-shared-conversation="answered-by">
      · answered by {answer.you ? "you" : answeredBy(answer)}
    </span>
  );
}
