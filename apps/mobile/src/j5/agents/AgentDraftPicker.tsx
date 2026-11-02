import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { selectDraftAgent } from "./agentDraftState";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** "Start as persona" for a new-task draft; lists launchable personas only. */
export function AgentDraftPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly disabled?: boolean;
}) {
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const agents = agentPersonaMentionItems(catalog.data ?? null, "");
  if (agents.length === 0) return null;
  return (
    <View pointerEvents={props.disabled ? "none" : "auto"}>
      <Menu
        actions={agents.map((agent) => ({
          id: `agent:${agent.personaId}`,
          title: agent.label,
          subtitle: agent.description,
          attributes: { disabled: props.disabled === true },
        }))}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event.startsWith("agent:"))
            selectDraftAgent(props.draftKey, nativeEvent.event.slice("agent:".length));
        }}
      >
        <ComposerInlineControl
          accessibilityLabel="Start this task as a persona"
          disabled={props.disabled}
          icon="person.crop.circle"
          label="Persona"
          showChevron={false}
        />
      </Menu>
    </View>
  );
}
