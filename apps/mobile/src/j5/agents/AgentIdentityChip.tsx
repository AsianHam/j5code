import { presentAgentPersonaAssignment } from "@t3tools/client-runtime/j5/agent-personas";
import type { OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

/** Compact "which persona is this" chip for thread rows. */
export function AgentIdentityChip(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment | undefined;
  /** Left inset that lines the chip up with the row's title text. */
  readonly inset?: number;
}) {
  if (props.assignment === undefined) return null;
  const presentation = presentAgentPersonaAssignment(props.assignment);
  return (
    <View
      accessibilityLabel={`Persona ${presentation.personaLabel}, ${presentation.routeLabel}`}
      className="mt-1 flex-row items-center gap-1 self-start rounded-full border border-border px-2 py-0.5"
      style={props.inset ? { marginLeft: props.inset } : undefined}
    >
      <SymbolView
        name="person.crop.circle"
        size={12}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {presentation.personaLabel}
      </Text>
    </View>
  );
}
