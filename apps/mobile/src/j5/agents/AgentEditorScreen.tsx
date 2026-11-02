import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { PersonaFormScreen, usePersonaFormExit, usePersonaFormParams } from "./PersonaFormScreen";

export function AgentEditorScreen() {
  const props = usePersonaFormParams<"SettingsPersonaEdit">();
  const [draft, setDraft] = useState(props.initial);
  // Instructions are not in the catalog; load them once the page opens.
  const [instructions, setInstructions] = useState<string | null>(null);
  const [loadedInstructions, setLoadedInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const exit = usePersonaFormExit({
    hasChanges:
      instructions !== loadedInstructions ||
      JSON.stringify(draft) !== JSON.stringify(props.initial),
    saving,
  });
  // The page may outlive the grant it was opened with, so its action follows the live answer.
  const canSave = useAtomValue(
    agentPersonaEnvironment.editImportedAgentPersona.permissionAtom(props.environmentId),
  );
  const save = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- loads the persona's instructions once when the editor opens; the read is a command, not an atom.
  useEffect(() => {
    let cancelled = false;
    void read({ environmentId: props.environmentId, input: { personaId: props.initial.personaId } })
      .then((result) => {
        if (cancelled) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setInstructions(result.value.definition.instructions);
        setLoadedInstructions(result.value.definition.instructions);
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
    const result = await save({
      environmentId: props.environmentId,
      input: {
        ...draft,
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        instructions,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    catalog.refresh();
    exit.leaveAfterSave();
  }
  return (
    <PersonaFormScreen title={"Edit persona"} guarded={exit.guarded}>
      <Text className="text-sm text-foreground-muted">
        Changes apply to this imported copy and future launches. The original file and existing
        tasks stay unchanged.
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
          Markdown. Instructions describe behavior; the runtime policy below is what is enforced.
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
    </PersonaFormScreen>
  );
}
