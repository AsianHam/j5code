import { createNativeStackScreen } from "@react-navigation/native-stack";

import { AgentCreateScreen } from "./AgentCreateScreen";
import { AgentEditorScreen } from "./AgentEditorScreen";
import { PlaybookConversationScreen } from "../playbooks/PlaybookConversationScreen";

/** The Personas page's forms, beside upstream's settings pages (FORK.md case 103). */
export const j5SettingsFormRoutes = <Options extends object>(options: Options) => ({
  SettingsPersonaNew: createNativeStackScreen({
    screen: AgentCreateScreen,
    options: { ...options, title: "Create persona" },
  }),
  SettingsPersonaEdit: createNativeStackScreen({
    screen: AgentEditorScreen,
    options: { ...options, title: "Edit persona" },
  }),
  SettingsPlaybookConversation: createNativeStackScreen({
    screen: PlaybookConversationScreen,
    options: { ...options, title: "Prepare chat" },
  }),
});
