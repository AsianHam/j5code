import { createFileRoute } from "@tanstack/react-router";

import { SkillInstallerSettings } from "../j5/skills/SkillInstallerSettings";

export const Route = createFileRoute("/_chat/settings/skills")({
  component: SkillInstallerSettings,
});
