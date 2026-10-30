import { presentAgentPersonaAssignment } from "@t3tools/client-runtime/j5/agent-personas";
import type {
  EnvironmentId,
  OrchestrationV2AgentPersonaAssignment,
  ThreadId,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { AgentHandoffChip } from "./AgentHandoffChip";
import { useThreadShell } from "../../state/entities";

/** Compact "which persona is this" chip for thread cards and runtime rows. */
export function AgentIdentityChip(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment | undefined;
  readonly className?: string;
}) {
  if (props.assignment === undefined) return null;
  const presentation = presentAgentPersonaAssignment(props.assignment);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={
              props.className ??
              "inline-flex max-w-36 shrink-0 items-center gap-1 truncate rounded-sm border border-border/60 px-1 text-3xs text-muted-foreground"
            }
          />
        }
      >
        <BotIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{presentation.personaLabel}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        Persona {presentation.personaLabel} · {presentation.routeLabel} ·{" "}
        {props.assignment.authorityPolicy}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Persona chip plus handoff link for upstream's lineage rows and subagent cards. Both are
 * interactive, so callers mount this beside the row's navigation button, never inside it. Runtime
 * rows know only the child thread; look up its shell for the pinned assignment.
 */
export function AgentRowIdentity(props: {
  readonly environmentId: EnvironmentId;
  readonly childThreadId: string | null;
}) {
  const shell = useThreadShell(
    props.childThreadId !== null
      ? { environmentId: props.environmentId, threadId: props.childThreadId as ThreadId }
      : null,
  );
  const assignment = shell?.agentPersonaAssignment;
  if (assignment === undefined || props.childThreadId === null) return null;
  return (
    <>
      <AgentIdentityChip assignment={assignment} />
      <AgentHandoffChip
        environmentId={props.environmentId}
        threadId={props.childThreadId as ThreadId}
      />
    </>
  );
}
