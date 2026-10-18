import { unseenHighlights } from "@t3tools/client-runtime/j5/highlights";
import { GiftIcon } from "lucide-react";
import { useEffect } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { SidebarMenuItem } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useClientSettings, useClientSettingsHydrationStatus } from "../../hooks/useSettings";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { closeHighlights, openHighlights, useHighlightsPopover } from "./highlightsPopover";
import { HighlightsList } from "./HighlightsList";
import { clientHighlights, dismissHighlight, useSeenHighlights } from "./seenHighlights";

// The row's icons, highlights and update button are 32px with 4px between; below this width the
// row cannot hold the button, so it hides until the palette opens it. Desktop has the update
// button too.
const HIDE_BELOW_CLASS_NAME = isElectron
  ? "@max-[13.25rem]/utility:hidden"
  : "@max-[11rem]/utility:hidden";

/**
 * The highlights button in the sidebar's utility row (#624): shown while this client has unseen
 * highlights, or while the palette's "What's new" has the list open. Opens on click only, since
 * the update button beside it opens on hover.
 */
export function SidebarHighlightsButton() {
  const seen = useSeenHighlights();
  const hydrated = useClientSettingsHydrationStatus() === "ready";
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const unseen = unseenHighlights({
    entries: clientHighlights,
    seen,
    firstRunComplete: hydrated && onboardingCompletedAt !== null,
  });
  const popover = useHighlightsPopover();
  const showingNew = popover.open && popover.mode === "new";

  // Dismissing the last unseen entry removes the button, and with it the list.
  useEffect(() => {
    if (showingNew && unseen.length === 0) closeHighlights();
  }, [showingNew, unseen.length]);

  if (unseen.length === 0 && !popover.open) return null;

  const label = unseen.length > 0 ? `What's new, ${unseen.length} new` : "What's new";

  return (
    <SidebarMenuItem
      className={cn("ms-auto shrink-0 [&+li]:ms-0", !popover.open && HIDE_BELOW_CLASS_NAME)}
    >
      <Popover
        open={popover.open}
        onOpenChange={(open) => {
          if (open) openHighlights("new");
          else closeHighlights();
        }}
      >
        <Tooltip disabled={popover.open}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    aria-label={label}
                    className="relative inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset"
                    type="button"
                  >
                    <GiftIcon aria-hidden className="size-4" />
                    {unseen.length > 0 ? (
                      <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
                        {unseen.length}
                      </span>
                    ) : null}
                  </button>
                }
              />
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        {popover.open ? (
          <PopoverPopup
            align="end"
            collisionAvoidance={{ align: "shift" }}
            sideOffset={10}
            aria-label={label}
            padding="none"
            side="top"
            width="lg"
          >
            {popover.mode === "new" ? (
              <HighlightsList
                entries={unseen}
                onDismiss={dismissHighlight}
                title="New in J5 Code"
              />
            ) : (
              <HighlightsList entries={clientHighlights} onDismiss={null} title="What's new" />
            )}
          </PopoverPopup>
        ) : null}
      </Popover>
    </SidebarMenuItem>
  );
}
