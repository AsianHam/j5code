import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaCatalogRow } from "@t3tools/client-runtime/j5/agent-personas";
import type { AgentPersonaModelTarget, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { personaDetailRows } from "./personaDetails";

/** A persona the person can't edit, such as one from a folder, shown read-only. */
export function AgentDetailsModal(props: {
  readonly environmentId: EnvironmentId;
  readonly persona: AgentPersonaCatalogRow;
  readonly usageLine: string | null;
  readonly onClose: () => void;
}) {
  const [models, setModels] = useState<
    | { readonly status: "loading" }
    | { readonly status: "failed" }
    | {
        readonly status: "loaded";
        readonly route: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget];
      }
  >({ status: "loading" });
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, { reportFailure: false });
  const personaId = props.persona.personaId;
  // oxlint-disable-next-line t3code/react-effect-budget -- loads the persona's models once when the sheet opens; the read is a command, not an atom.
  useEffect(() => {
    let cancelled = false;
    void read({ environmentId: props.environmentId, input: { personaId } })
      .then((result) => {
        if (cancelled) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setModels({ status: "loaded", route: result.value.definition.modelRoute });
      })
      .catch(() => {
        if (!cancelled) setModels({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, personaId, read]);
  const rows = personaDetailRows(props.persona, models, props.usageLine);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      {/* SafeAreaView takes no className, so the theme surface and flex go on a View. */}
      <View className="flex-1 bg-sheet">
        <SafeAreaView style={{ flex: 1 }}>
          <View className="flex-row items-center justify-between gap-3 px-5 py-3">
            <Text className="min-w-0 shrink text-xl font-t3-semibold" numberOfLines={1}>
              {props.persona.displayName}
            </Text>
            <Pressable accessibilityRole="button" onPress={props.onClose} className="px-3 py-2">
              <Text>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="px-5 pb-6">
            <SettingsSection>
              {rows.map((row, index) => (
                <View
                  key={`${row.label}:${row.value}`}
                  className={cn(index > 0 && "border-t border-border-subtle")}
                >
                  <ListRowLayout
                    label={row.label}
                    description={row.value}
                    {...(row.tone === undefined ? {} : { tone: row.tone })}
                  />
                </View>
              ))}
            </SettingsSection>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
