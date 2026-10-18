import { AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE } from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaImportConflict,
  AgentPersonaImportConflictError,
} from "@t3tools/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";

export function AgentImportConflictModal(props: {
  error: AgentPersonaImportConflictError;
  onConfirm: (selected: ReadonlyArray<AgentPersonaImportConflict> | null) => void;
}) {
  const [selected, setSelected] = useState(props.error.conflicts);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => props.onConfirm(null)}
    >
      <SafeAreaView className="flex-1 bg-sheet">
        <View className="flex-row items-center justify-between gap-3 px-5 py-3">
          <Text className="flex-1 text-xl font-t3-semibold">Replace existing personas?</Text>
          <Pressable
            accessibilityRole="button"
            className="px-3 py-2"
            onPress={() => props.onConfirm(null)}
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="gap-4 px-5 pb-6">
          <Text>{props.error.message}</Text>
          <Text className="text-sm text-foreground-muted">
            {AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE}
          </Text>
          {props.error.conflicts.map((conflict) => {
            const checked = selected.some(({ personaId }) => personaId === conflict.personaId);
            return (
              <View
                key={conflict.personaId}
                className="flex-row items-center justify-between gap-4 rounded-xl border border-border p-3"
              >
                <View className="flex-1">
                  <Text className="font-t3-semibold">{conflict.displayName}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {conflict.personaId} · {checked ? "Replace" : "Skip"}
                  </Text>
                </View>
                <Switch
                  accessibilityLabel={`Replace ${conflict.displayName} (${conflict.personaId})`}
                  value={checked}
                  onValueChange={(enabled) =>
                    setSelected(
                      enabled
                        ? [...selected, conflict]
                        : selected.filter(({ personaId }) => personaId !== conflict.personaId),
                    )
                  }
                />
              </View>
            );
          })}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          className="mx-5 mb-4 items-center rounded-xl bg-danger-foreground px-4 py-3"
          onPress={() => props.onConfirm(selected)}
        >
          <Text className="font-t3-semibold text-primary-foreground">Import selected</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}
