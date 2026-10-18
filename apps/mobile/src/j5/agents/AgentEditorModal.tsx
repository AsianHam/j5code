import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaEditInput, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

export function AgentEditorModal(props: {
  environmentId: EnvironmentId;
  initial: Omit<AgentPersonaEditInput, "instructions">;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  // Instructions are not in the catalog; load them once the sheet opens.
  const [instructions, setInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The sheet may outlive the grant it was opened with, so its action follows the live answer.
  const canSave = useAtomValue(
    agentPersonaEnvironment.editImportedAgentPersona.permissionAtom(props.environmentId),
  );
  const save = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  useEffect(() => {
    let cancelled = false;
    void read({ environmentId: props.environmentId, input: { personaId: props.initial.personaId } })
      .then((result) => {
        if (cancelled) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setInstructions(result.value.definition.instructions);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.initial.personaId, read]);
  async function submit() {
    if (saving || instructions === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await save({
        environmentId: props.environmentId,
        input: {
          ...draft,
          displayName: draft.displayName.trim(),
          description: draft.description.trim(),
          instructions,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      props.onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!saving) props.onClose();
      }}
    >
      <SafeAreaView className="flex-1 bg-sheet">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center justify-between px-5 py-3">
            <Text className="text-xl font-t3-semibold">Edit persona</Text>
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={props.onClose}
              className="px-3 py-2"
            >
              <Text>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-4 px-5 pb-6"
          >
            <Text className="text-sm text-foreground-muted">
              Changes apply to this imported copy and future launches. The original file and
              existing tasks stay unchanged.
            </Text>
            <View className="gap-2">
              <Text>Name</Text>
              <TextInput
                accessibilityLabel="Name"
                value={draft.displayName}
                editable={!saving}
                onChangeText={(displayName) => setDraft({ ...draft, displayName })}
              />
            </View>
            <View className="gap-2">
              <Text>Description</Text>
              <TextInput
                accessibilityLabel="Description"
                multiline
                value={draft.description}
                editable={!saving}
                onChangeText={(description) => setDraft({ ...draft, description })}
              />
            </View>
            <View className="gap-2">
              <Text>Instructions</Text>
              <TextInput
                accessibilityLabel="Instructions"
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                style={{ minHeight: 160 }}
                placeholder={instructions === null ? "Loading…" : undefined}
                value={instructions ?? ""}
                editable={!saving && instructions !== null}
                onChangeText={setInstructions}
              />
              <Text className="text-xs text-foreground-muted">
                Markdown. Instructions describe behavior; the runtime policy below is what is
                enforced.
              </Text>
            </View>
            <AgentRoutePolicyFields
              environmentId={props.environmentId}
              value={draft}
              retainRoute={props.initial.modelRoute}
              disabled={saving}
              onChange={(next) => setDraft({ ...draft, ...next })}
            />
            {error ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={
                saving ||
                !canSave ||
                instructions === null ||
                !instructions.trim() ||
                !draft.displayName.trim() ||
                !draft.description.trim()
              }
              className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40"
              onPress={() => void submit()}
            >
              <Text className="font-t3-semibold text-primary-foreground">
                {saving ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
