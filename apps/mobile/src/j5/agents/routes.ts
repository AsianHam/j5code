import { createNativeStackScreen } from "@react-navigation/native-stack";

import { AgentCreateScreen } from "./AgentCreateScreen";
import { AgentEditorScreen } from "./AgentEditorScreen";

/** The persona forms, beside upstream's settings pages (FORK.md case 103). */
export const j5PersonaFormRoutes = <Options extends object>(options: Options) => ({
  SettingsPersonaNew: createNativeStackScreen({
    screen: AgentCreateScreen,
    options: { ...options, title: "Create persona" },
  }),
  SettingsPersonaEdit: createNativeStackScreen({
    screen: AgentEditorScreen,
    options: { ...options, title: "Edit persona" },
  }),
});
