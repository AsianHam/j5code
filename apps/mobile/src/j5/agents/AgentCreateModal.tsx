import { useAtomValue } from "@effect/atom-react";
import {
  agentPersonaIdError,
  agentPersonaIdFromName,
  agentPersonaPolicyDrivers,
  defaultAgentPersonaModelRoute,
  type AgentPersonaCreateDraft,
} from "@t3tools/client-runtime/j5/agent-personas";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaModelTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** Author a personal agent; it is stored as an imported definition of this environment. */
export function AgentCreateModal(props: {
  environmentId: EnvironmentId;
  /** Prefill from an existing agent (Duplicate); the ID is treated as user-chosen. */
  initial?: AgentPersonaCreateDraft;
  onClose: () => void;
  onCreated: (displayName: string) => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  // New personas start on read-only, so prefer a provider that sandboxes it.
  const defaultRoute = defaultAgentPersonaModelRoute(
    providers ?? [],
    agentPersonaPolicyDrivers(catalog.data, "read-only"),
  );
  const [draft, setDraft] = useState<{
    displayName: string;
    id: string;
    idEdited: boolean;
    description: string;
    instructions: string;
    authorityPolicy: AgentPersonaAuthorityPolicy;
    modelRoute: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget] | null;
  }>(
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelRoute = draft.modelRoute ?? defaultRoute;
  const idError = agentPersonaIdError(draft.id);
  const create = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  // The sheet may outlive the grant it was opened with, so its action follows the live answer.
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
    try {
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
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      props.onCreated(draft.displayName.trim());
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
            <Text className="text-xl font-t3-semibold">
              {props.initial ? "Duplicate persona" : "Create persona"}
            </Text>
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
              A personal persona for this environment. It joins the library like an import, so you
              can edit, switch off, or remove it later.
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
                Markdown. Instructions describe behavior; the runtime policy below is what is
                enforced.
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
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
