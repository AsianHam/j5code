import {
  usePreventRemove,
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { AgentPersonaCreateDraft } from "@t3tools/client-runtime/j5/agent-personas";
import type { AgentPersonaEditInput, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { withNativeGlassHeaderItem } from "../../features/layout/native-glass-header-items";
import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { NativeStackScreenOptions } from "../../native/StackHeader";

export type SettingsFormRoutes = {
  SettingsPersonaNew: {
    readonly environmentId: EnvironmentId;
    /** Prefill from an existing persona (Duplicate); the ID is treated as user-chosen. */
    readonly initial?: AgentPersonaCreateDraft;
  };
  SettingsPersonaEdit: {
    readonly environmentId: EnvironmentId;
    readonly initial: Omit<AgentPersonaEditInput, "instructions">;
  };
  SettingsPlaybookConversation: {
    readonly environmentId: EnvironmentId;
    readonly name: string | null;
    /** The project Settings is showing, so a project playbook's chat opens where it lives. */
    readonly projectId: ProjectId | null;
  };
};

export function useSettingsFormNavigation() {
  return useNavigation<NativeStackNavigationProp<SettingsFormRoutes>>();
}

export function useSettingsFormParams<Name extends keyof SettingsFormRoutes>() {
  return useRoute<RouteProp<SettingsFormRoutes, Name>>().params as SettingsFormRoutes[Name];
}

/** Asks before unsaved changes are lost, and returns how to leave once the work is done. */
export function useSettingsFormExit(options: {
  readonly hasChanges: boolean;
  readonly saving: boolean;
}) {
  const navigation = useNavigation();
  // Set once the save lands, so the removal guard lets the form close.
  const saved = useRef(false);
  const guarded = options.hasChanges || options.saving;
  usePreventRemove(guarded, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (options.saving) {
      Dialog.alert("Still working", "Wait for this to finish before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  return {
    guarded,
    /** For a form that leaves by its own navigation action. */
    allowLeaving: () => {
      saved.current = true;
    },
    leaveAfterSave: () => {
      saved.current = true;
      if (navigation.isFocused()) navigation.goBack();
    },
  };
}

/** A pushed settings page, because Android's Menu can't draw over an RN Modal or Sheet. */
export function SettingsFormScreen(props: {
  readonly title: string;
  readonly guarded: boolean;
  readonly children: ReactNode;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          // A custom back item also turns off iOS's swipe back, so it stays only while guarded.
          options={
            props.guarded
              ? {
                  headerBackVisible: false,
                  gestureEnabled: false,
                  // Native Back pops before removal guards; a bar action lets the guard run first.
                  unstable_headerLeftItems: () => [
                    withNativeGlassHeaderItem({
                      type: "button",
                      label: "",
                      accessibilityLabel: "Back",
                      icon: { type: "sfSymbol", name: "chevron.backward" },
                      onPress: () => navigation.goBack(),
                    }),
                  ],
                }
              : {
                  headerBackVisible: true,
                  gestureEnabled: true,
                  unstable_headerLeftItems: undefined,
                }
          }
        />
      ) : null}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {props.children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SettingsScreen>
  );
}
