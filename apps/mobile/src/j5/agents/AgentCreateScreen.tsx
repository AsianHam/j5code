import { useAtomValue } from "@effect/atom-react";
import {
  agentPersonaIdError,
  agentPersonaIdFromName,
  agentPersonaPolicyDrivers,
  defaultAgentPersonaModelRoute,
} from "@t3tools/client-runtime/j5/agent-personas";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaAuthorityPolicy, AgentPersonaModelTarget } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { PersonaFormScreen, usePersonaFormExit, usePersonaFormParams } from "./PersonaFormScreen";

type PersonaDraft = {
  displayName: string;
  id: string;
  idEdited: boolean;
  description: string;
  instructions: string;
  authorityPolicy: AgentPersonaAuthorityPolicy;
  modelRoute: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget] | null;
};

/** Author a personal agent; it is stored as an imported definition of this environment. */
export function AgentCreateScreen() {
  const props = usePersonaFormParams<"SettingsPersonaNew">();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  // New personas start on read-only, so prefer a provider that sandboxes it.
  const defaultRoute = defaultAgentPersonaModelRoute(
    providers ?? [],
    agentPersonaPolicyDrivers(catalog.data, "read-only"),
  );
  const [startingDraft] = useState<PersonaDraft>(
    props.initial
      ? { ...props.initial, idEdited: true }
      : {
          displayName: "",
          id: "",
          idEdited: false,
          description: "",
          instructions: "",
          authorityPolicy: "read-only",
          modelRoute: null,
        },
  );
  const [draft, setDraft] = useState(startingDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exit = usePersonaFormExit({
    hasChanges: JSON.stringify(draft) !== JSON.stringify(startingDraft),
    saving,
  });
  const modelRoute = draft.modelRoute ?? defaultRoute;
  const idError = agentPersonaIdError(draft.id);
  const create = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  // The page may outlive the grant it was opened with, so its action follows the live answer.
  const canCreate = useAtomValue(
    agentPersonaEnvironment.createAgentPersona.permissionAtom(props.environmentId),
  );
  const ready =
    !saving &&
    canCreate &&
    idError === null &&
    draft.displayName.trim() !== "" &&
    draft.description.trim() !== "" &&
    draft.instructions.trim() !== "" &&
    modelRoute !== null;
  async function submit() {
    if (!ready || modelRoute === null) return;
    setSaving(true);
    setError(null);
    const result = await create({
      environmentId: props.environmentId,
      input: {
        id: draft.id,
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions,
        authorityPolicy: draft.authorityPolicy,
        modelRoute: [modelRoute[0], modelRoute[1]],
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
    <PersonaFormScreen
      title={props.initial ? "Duplicate persona" : "Create persona"}
      guarded={exit.guarded}
    >
      <Text className="text-sm text-foreground-muted">
        A personal persona for this environment. It joins the library like an import, so you can
        edit, switch off, or remove it later.
      </Text>
      <View className="gap-2">
        <Text>Name</Text>
        <TextInput
          accessibilityLabel="Name"
          value={draft.displayName}
          editable={!saving}
          onChangeText={(displayName) =>
            setDraft({
              ...draft,
              displayName,
              id: draft.idEdited ? draft.id : agentPersonaIdFromName(displayName),
            })
          }
        />
      </View>
      <View className="gap-2">
        <Text>ID</Text>
        <TextInput
          accessibilityLabel="ID"
          autoCapitalize="none"
          autoCorrect={false}
          value={draft.id}
          editable={!saving}
          onChangeText={(id) => setDraft({ ...draft, id: id.trim(), idEdited: true })}
        />
        <Text className="text-xs text-foreground-muted">
          {draft.id !== "" && idError !== null
            ? idError
            : "Stable identifier used in @persona: mentions. Lowercase letters, digits, hyphens."}
        </Text>
      </View>
      <View className="gap-2">
        <Text>Description</Text>
        <TextInput
          accessibilityLabel="Description"
          multiline
          placeholder="One sentence on what this persona is for."
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
          placeholder="# Who this persona is"
          value={draft.instructions}
          editable={!saving}
          onChangeText={(instructions) => setDraft({ ...draft, instructions })}
        />
        <Text className="text-xs text-foreground-muted">
          Markdown. Instructions describe behavior; the runtime policy below is what is enforced.
        </Text>
      </View>
      {modelRoute === null ? (
        <Text className="text-sm text-foreground-muted">
          Sign in to Codex or Claude on this environment to choose the persona's models.
        </Text>
      ) : (
        <AgentRoutePolicyFields
          environmentId={props.environmentId}
          value={{ authorityPolicy: draft.authorityPolicy, modelRoute }}
          disabled={saving}
          onChange={(next) => setDraft({ ...draft, ...next })}
        />
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40"
        onPress={() => void submit()}
      >
        <Text className="font-t3-semibold text-primary-foreground">
          {saving ? "Creating…" : "Create persona"}
        </Text>
      </Pressable>
    </PersonaFormScreen>
  );
}
