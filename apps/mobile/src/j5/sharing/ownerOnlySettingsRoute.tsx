import { useRoute } from "@react-navigation/native";
import type { ComponentType } from "react";

import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { useOwnerSomewhere } from "./guestAccess";
import { settingsPageShown } from "./settingsAccess.logic";

/**
 * A Settings route whose page is drawn without upstream's `SettingsScreen` (Archive): for someone
 * who owns no connected server it draws an empty `SettingsScreen`, whose gate puts the notice
 * under the page's own header, and the page itself, with its reads, is never mounted.
 */
export function ownerOnlySettingsRoute(Screen: ComponentType, title: string): ComponentType {
  function OwnerOnlySettingsRoute() {
    const routeName = useRoute().name;
    return settingsPageShown(routeName, useOwnerSomewhere()) ? (
      <Screen />
    ) : (
      <SettingsScreen title={title}>{null}</SettingsScreen>
    );
  }
  return OwnerOnlySettingsRoute;
}
