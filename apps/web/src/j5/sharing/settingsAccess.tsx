import type { EnvironmentId } from "@t3tools/contracts";
import { Navigate } from "@tanstack/react-router";
import { ScrollTextIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo } from "react";

import type { SettingsPath } from "../../components/settings/settingsSearch";
import { useIsOwnerSomewhere, useOwnedEnvironmentIds } from "./access";
import {
  FIRST_PAGE_FOR_EVERYONE,
  LICENSES_PATH,
  PAGES_FOR_EVERYONE,
  settingsNavItems,
  settingsPageShown,
} from "./settingsAccess.logic";

type NavItem = {
  readonly label: string;
  readonly to: SettingsPath;
  readonly icon: ComponentType<{ className?: string }>;
};

// Upstream's navigation takes any route it can navigate to; Licenses is not one of its sections,
// so it is not in `SettingsPath`, which only types the table.
const LICENSES_ITEM = {
  label: "Open-source licenses",
  to: LICENSES_PATH as SettingsPath,
  icon: ScrollTextIcon,
};

/** Settings' sidebar as this person sees it; see `settingsNavItems`. */
export function useSettingsNavItems<Item extends NavItem>(items: ReadonlyArray<Item>) {
  return settingsNavItems<NavItem>(
    items,
    useIsOwnerSomewhere(),
    LICENSES_ITEM,
  ) as ReadonlyArray<Item>;
}

/** Settings search finds only the pages a person is shown (AC28). */
export function useShownSettingsSearchItems<Item extends { readonly to: string }>(
  items: ReadonlyArray<Item>,
): ReadonlyArray<Item> {
  const ownerSomewhere = useIsOwnerSomewhere();
  return ownerSomewhere ? items : items.filter((item) => PAGES_FOR_EVERYONE.has(item.to));
}

/**
 * Sends someone who owns no connected server from a page that is not theirs to the first one
 * that is (AC29), so an address typed or kept from before shows nothing it should not.
 */
export function SettingsPageGate({
  pathname,
  children,
}: {
  readonly pathname: string;
  readonly children: ReactNode;
}) {
  const ownerSomewhere = useIsOwnerSomewhere();
  if (settingsPageShown({ path: pathname, ownerSomewhere })) return children;
  return <Navigate to={FIRST_PAGE_FOR_EVERYONE} replace />;
}

/**
 * The servers Settings manages: only those the person owns (AC27). Upstream applies a change to
 * every listed server and disables a row unless all of them allow it, so a server the person
 * does not own would grey out an Owner's Settings for the servers that are theirs.
 */
export function useOwnedEnvironments<Environment extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<Environment>,
): ReadonlyArray<Environment> {
  const owned = useOwnedEnvironmentIds();
  return useMemo(
    () => environments.filter((environment) => owned.has(environment.environmentId)),
    [environments, owned],
  );
}
