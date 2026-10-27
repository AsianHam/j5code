import { createFileRoute } from "@tanstack/react-router";

import { AgentSettingsPanel } from "../components/settings/AgentSettingsPanel";

export const Route = createFileRoute("/_chat/settings/personas")({
  component: AgentSettingsPanel,
});
