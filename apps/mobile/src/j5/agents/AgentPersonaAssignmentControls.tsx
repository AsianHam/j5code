import {
  AGENT_PERSONA_DRIFT_MESSAGE,
  agentPersonaDrift,
  presentAgentHandoff,
  presentAgentPersonaAssignment,
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  EnvironmentId,
  OrchestrationV2AgentPersonaAssignment,
  ThreadId,
} from "@t3tools/contracts";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { useEnvironmentQuery } from "../../state/query";
import { clearDraftAgent } from "./agentDraftState";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** Replaces the model control for a persona thread: the launch route is fixed. */
export function AgentPersonaAssignmentControls(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment;
  /** When known, the current library is compared with the launch snapshot to show drift. */
  readonly environmentId?: EnvironmentId;
  /** The unsent draft's composer key, where the choice can still be undone. */
  readonly draftKey?: string;
  /** The server thread this control belongs to; enables the handoff artifact status. */
  readonly threadId?: ThreadId;
}) {
  const presentation = presentAgentPersonaAssignment(props.assignment);
  const handoffs = useEnvironmentQuery(
    props.environmentId === undefined || props.threadId === undefined
      ? null
      : // Environment-wide and shared with every other handoff reader; refreshed by the server signal.
        agentPersonaEnvironment.handoffs({ environmentId: props.environmentId, input: {} }),
  );
  const handoff = handoffs.data?.handoffs.find((entry) => entry.threadId === props.threadId);
  const handoffPresentation = handoff === undefined ? null : presentAgentHandoff(handoff);
  const catalog = useEnvironmentQuery(
    props.environmentId === undefined
      ? null
      : agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const drift = agentPersonaDrift(props.assignment, catalog.data);
  const draftKey = props.draftKey;
  return (
    <>
      <ComposerInlineControl
        accessibilityLabel={`Persona: ${presentation.personaLabel}`}
        emphasized
        icon="person.crop.circle"
        label={presentation.personaLabel}
        maxWidth={152}
        static
      />
      <ComposerInlineControl
        accessibilityLabel={`Assigned model: ${presentation.routeLabel}`}
        label={presentation.routeLabel}
        maxWidth={200}
        static
      />
      {draftKey !== undefined ? (
        <ComposerInlineControl
          accessibilityLabel="Remove persona"
          accessibilityHint="Start as a regular task instead"
          icon="xmark"
          label=""
          maxWidth={44}
          onPress={() => clearDraftAgent(draftKey)}
        />
      ) : null}
      {handoffPresentation ? (
        <ComposerInlineControl
          accessibilityLabel={`Handoff artifact: ${handoffPresentation.label}`}
          accessibilityHint={handoffPresentation.detail}
          icon={handoffPresentation.tone === "success" ? "doc.text" : "exclamationmark.triangle"}
          label={handoffPresentation.label}
          maxWidth={200}
          static
        />
      ) : null}
      {drift === "changed" ? (
        <ComposerInlineControl
          accessibilityLabel="Persona definition changed since launch"
          accessibilityHint={AGENT_PERSONA_DRIFT_MESSAGE}
          icon="exclamationmark.triangle"
          label="Changed"
          maxWidth={120}
          static
        />
      ) : null}
    </>
  );
}
