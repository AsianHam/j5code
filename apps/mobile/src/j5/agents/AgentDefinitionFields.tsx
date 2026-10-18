import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_PERSONA_POLICY_OPTIONS,
  agentPersonaModelChoiceId,
  agentPersonaModelChoices,
  agentPersonaModelGroups,
  agentPersonaPolicyDrivers,
  agentPersonaPolicyNote,
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaModelTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

export interface AgentRoutePolicyValue {
  readonly authorityPolicy: AgentPersonaAuthorityPolicy;
  readonly modelRoute: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget];
}

export function EditorChoice(props: {
  label: string;
  accessibilityLabel?: string;
  value: string;
  disabled: boolean;
  choices: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium">{props.label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        accessibilityState={{ expanded, disabled: props.disabled }}
        disabled={props.disabled}
        className="rounded-xl border border-border px-3 py-3"
        onPress={() => setExpanded(!expanded)}
      >
        <Text>
          {props.choices.find(({ value }) => value === props.value)?.label ?? props.value}
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 200 }}
          className="rounded-xl border border-border"
        >
          {props.choices.map((choice) => (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: props.value === choice.value }}
              disabled={props.disabled}
              className="border-b border-border-subtle px-3 py-3"
              onPress={() => {
                props.onChange(choice.value);
                setExpanded(false);
              }}
            >
              <Text
                className={
                  props.value === choice.value ? "font-t3-semibold text-primary" : "text-foreground"
                }
              >
                {choice.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Runtime policy plus primary/fallback route pickers, shared by the create and edit modals. */
export function AgentRoutePolicyFields(props: {
  environmentId: EnvironmentId;
  value: AgentRoutePolicyValue;
  retainRoute?: ReadonlyArray<AgentPersonaModelTarget>;
  disabled: boolean;
  onChange: (next: AgentRoutePolicyValue) => void;
}) {
  const { value, disabled } = props;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const choices = agentPersonaModelChoices(providers ?? [], [
    ...(props.retainRoute ?? []),
    ...value.modelRoute,
  ]);
  const modelGroups = agentPersonaModelGroups(choices);
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const policyNote = agentPersonaPolicyNote(
    agentPersonaPolicyDrivers(catalog.data, value.authorityPolicy),
    value.modelRoute,
    value.authorityPolicy,
  );
  return (
    <>
      <EditorChoice
        label="Runtime policy"
        value={value.authorityPolicy}
        disabled={disabled}
        choices={AGENT_PERSONA_POLICY_OPTIONS}
        onChange={(next) => {
          const policy = AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === next);
          if (policy) props.onChange({ ...value, authorityPolicy: policy.value });
        }}
      />
      {policyNote === null ? null : (
        <Text className="text-xs text-foreground-muted">{policyNote}</Text>
      )}
      {value.modelRoute.map((target, index) => {
        const label = index === 0 ? "Primary model" : "Fallback model";
        const selected = choices.find(({ id }) => id === agentPersonaModelChoiceId(target));
        const updateTarget = (next: AgentPersonaModelTarget) =>
          props.onChange({
            ...value,
            modelRoute: index === 0 ? [next, value.modelRoute[1]] : [value.modelRoute[0], next],
          });
        return (
          <View key={label} className="gap-3 rounded-xl border border-border p-3">
            <View className="flex-row items-start gap-2">
              <View className="min-w-0 flex-1 gap-2">
                <Text className="text-sm font-t3-medium">{label}</Text>
                <Menu
                  actions={modelGroups.map((harness) => ({
                    id: harness.driver,
                    title: harness.label,
                    attributes: {
                      disabled:
                        disabled || !harness.models.some(({ efforts }) => efforts.length > 0),
                    },
                    subactions: harness.models.map(({ id, modelLabel, efforts }) => ({
                      id,
                      title: modelLabel,
                      state: id === agentPersonaModelChoiceId(target) ? "on" : "off",
                      attributes: { disabled: disabled || efforts.length === 0 },
                    })),
                  }))}
                  onPressAction={({ nativeEvent }) => {
                    const choice = choices.find(({ id }) => id === nativeEvent.event);
                    if (!disabled && choice?.available && choice.efforts.length > 0)
                      updateTarget({
                        ...choice.target,
                        reasoningEffort: choice.efforts.includes(target.reasoningEffort)
                          ? target.reasoningEffort
                          : choice.target.reasoningEffort,
                      });
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    disabled={disabled}
                    className="rounded-xl border border-border px-3 py-3"
                  >
                    <Text numberOfLines={1}>{selected?.label}</Text>
                  </Pressable>
                </Menu>
              </View>
              <View className="w-28">
                <EditorChoice
                  label="Reasoning"
                  accessibilityLabel={`${label} reasoning`}
                  value={target.reasoningEffort}
                  disabled={disabled || !selected?.efforts.length}
                  choices={(selected?.efforts ?? []).map((effort) => ({
                    value: effort,
                    label: effort,
                  }))}
                  onChange={(reasoningEffort) => updateTarget({ ...target, reasoningEffort })}
                />
              </View>
            </View>
          </View>
        );
      })}
      <Text className="text-xs text-foreground-muted">
        Model availability and runtime policy support are checked for each launch.
      </Text>
    </>
  );
}
