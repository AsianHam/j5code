import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { ScrollTextIcon } from "lucide-react";
import { type ComponentType, type ReactNode } from "react";

import type { SettingsPath } from "../../components/settings/settingsSearch";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useOwnedEnvironmentIds, useOwnerSomewhere, useWritesSomewhere } from "./access";
import {
  LICENSES_PATH,
  PAGES_FOR_EVERYONE,
  ownerOnlySettingsNotice,
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
    useOwnerSomewhere() === true,
    LICENSES_ITEM,
  ) as ReadonlyArray<Item>;
}

/** Settings search finds only the pages a person is shown (AC28). */
export function useShownSettingsSearchItems<Item extends { readonly to: string }>(
  items: ReadonlyArray<Item>,
): ReadonlyArray<Item> {
  const ownerSomewhere = useOwnerSomewhere() === true;
  return ownerSomewhere ? items : items.filter((item) => PAGES_FOR_EVERYONE.has(item.to));
}

/**
 * Shows someone who owns no connected server a notice in place of a page that is not theirs
 * (AC29), so a link to it, such as a thread's "Manage scheduled tasks", or an address kept from
 * before shows nothing it should not and still lands somewhere.
 */
export function SettingsPageGate({
  pathname,
  children,
}: {
  readonly pathname: string;
  readonly children: ReactNode;
}) {
  const ownerSomewhere = useOwnerSomewhere();
  // Only an answer replaces a page: an Owner reloading one of their pages keeps it, and a
  // server still being asked holds no page back. The server refuses what is not theirs to read.
  if (ownerSomewhere !== false || settingsPageShown({ path: pathname, ownerSomewhere })) {
    return children;
  }
  return <OwnerOnlySettingsNotice />;
}

// Drawn as Settings draws a page, without upstream's "Applying settings for…" line: the person
// owns none of the servers that line would name.
function OwnerOnlySettingsNotice() {
  // A link names the server it is for, such as a thread's "Manage scheduled tasks".
  const linked = useLocation({
    select: (location) => {
      const search = location.search as Record<string, unknown>;
      const id = search.environmentId ?? search.machine;
      return typeof id === "string" ? (id as EnvironmentId) : null;
    },
  });
  const linkedServer = useEnvironment(linked);
  const primary = useEnvironment(usePrimaryEnvironmentId());
  const notice = ownerOnlySettingsNotice({
    serverName: linkedServer?.label ?? primary?.label ?? null,
    writesSomewhere: useWritesSomewhere(),
  });
  return (
    <div
      className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto"
      data-settings-page-scroll
    >
      <WorkspacePageContainer width="readable">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{notice.title}</EmptyTitle>
            <EmptyDescription>{notice.body}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspacePageContainer>
    </div>
  );
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
  return environments.filter((environment) => owned.has(environment.environmentId));
}
