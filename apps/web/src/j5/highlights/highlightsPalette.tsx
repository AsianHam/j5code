import { useLocation } from "@tanstack/react-router";
import { GiftIcon } from "lucide-react";
import { useEffect } from "react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import {
  isSidebarUtilityPage,
  useNavigateToMainApp,
} from "../../components/sidebar/mainAppLocation";
import { useSidebar } from "../../components/ui/sidebar";
import { openHighlights, useHighlightsPopover } from "./highlightsPopover";

const WHATS_NEW_ITEM: CommandPaletteActionItem = {
  kind: "action",
  value: "action:j5-whats-new",
  searchTerms: ["what's new", "whats new", "highlights", "new features", "release", "changelog"],
  title: "What's new",
  icon: <GiftIcon className={ITEM_ICON_CLASS} />,
  run: async () => openHighlights("all"),
};

/** The palette's "What's new": every highlight in the sidebar's popover, nothing to dismiss. */
export function useHighlightsPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  return [WHATS_NEW_ITEM];
}

/**
 * The list opens from the sidebar's utility row, which a utility page replaces with Back and a
 * collapsed sidebar hides. Mounted inside the sidebar provider, this leaves the page and opens
 * the sidebar so the button is there to anchor it.
 */
export function HighlightsSidebarReveal() {
  const popover = useHighlightsPopover();
  const onUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const requested = popover.open && popover.mode === "all";

  useEffect(() => {
    if (!requested) return;
    if (onUtilityPage) void navigateToMainApp();
    if (isMobile && !openMobile) setOpenMobile(true);
    if (!isMobile && !open) setOpen(true);
  }, [
    requested,
    onUtilityPage,
    navigateToMainApp,
    isMobile,
    open,
    openMobile,
    setOpen,
    setOpenMobile,
  ]);

  return null;
}
