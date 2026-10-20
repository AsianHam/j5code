import { ArrowUpRightIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { ScopedNativeQuestionInboxItem } from "../crew/crewRuntimeRequests.logic";
import { useLogicalProjects } from "../logicalProjects";

export function NativeQuestionInboxSection(props: {
  readonly questions: ReadonlyArray<ScopedNativeQuestionInboxItem>;
  readonly onOpenThread: (question: ScopedNativeQuestionInboxItem) => void;
}) {
  const projectOf = useLogicalProjects();
  if (props.questions.length === 0) return null;
  return (
    <section aria-label="Agent questions" className="mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agent questions
      </h2>
      <ul className="space-y-4">
        {props.questions.map((question) => (
          <li
            key={`${question.environmentId}:${question.threadId}:${question.requestId}`}
            className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
          >
            <h3 className="font-medium">{question.threadTitle}</h3>
            <p className="mt-1 text-muted-foreground">
              {projectOf(question.environmentId, question.projectId)?.displayName ??
                question.projectId}
              {question.crew ? ` · ${question.crew.name} · ${question.crew.seat}` : ""}
              {` · ${question.environmentLabel}${question.connected ? "" : " (offline)"}`}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>
                {question.responseCapability === "live"
                  ? "Waiting for an answer to continue."
                  : "Asked a question while continuing its work."}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!question.connected}
                onClick={() => props.onOpenThread(question)}
              >
                Open question <ArrowUpRightIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
