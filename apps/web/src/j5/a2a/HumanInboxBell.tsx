import { Link } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useCallback } from "react";
import { useAtomValue } from "@effect/atom-react";
import { mergeOpenInboxCounts } from "@t3tools/client-runtime/j5/inbox";

import { useSidebar } from "../../components/ui/sidebar";
import { cn } from "../../lib/utils";
import { inboxCrewRequests } from "../crew/crewProposals.logic";
import { mergeCrewProposalSources, useCrewProposalsRefresh } from "../crew/crewProposalsClient";
import { inboxBadgeCount } from "../crew/crewRuntimeRequests.logic";
import { useCrewRuntimeRequests } from "../crew/crewRuntimeRequestsClient";
import {
  crewProposalSourcesAtom,
  inboxCountQueryAtom,
  inboxCountSourcesAtom,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";

const useCountRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(inboxCountSourcesAtom, inboxCountQueryAtom);
});

export const shouldShowOpenInboxCount = (count: number | null) => count !== null && count > 0;

export function HumanInboxBell({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const sources = useAtomValue(inboxCountSourcesAtom);
  const crewSources = useAtomValue(crewProposalSourcesAtom);
  const merged = mergeOpenInboxCounts(sources);
  // Mid-run seat requests and seats' provider approvals wait on the person too; the badge counts
  // them beside open questions. The initial roster and the Captain's own requests are answered
  // inline in the Captain's thread and stay off the inbox badge.
  const crewRequests = inboxCrewRequests(mergeCrewProposalSources(crewSources)).length;
  const runtimeRequests = useCrewRuntimeRequests().length;
  const count = inboxBadgeCount(merged.count, crewRequests, runtimeRequests);
  const incomplete = merged.incomplete;
  useCountRefresh();
  useCrewProposalsRefresh();

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const label = `${count === null ? "Open inbox" : `Open inbox, ${incomplete ? "last known " : ""}${count} open`}${incomplete ? "; some environments could not be refreshed" : ""}`;
  return (
    <Link
      aria-label={label}
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring",
        onBackdrop
          ? "text-white/80 hover:bg-white/15 hover:text-white"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      onClick={closeMobileSidebar}
      title={label}
      to="/inbox"
    >
      <InboxIcon aria-hidden className="size-4" />
      {shouldShowOpenInboxCount(count) || incomplete ? (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {incomplete ? (count !== null && count > 0 ? `${count}*` : "?") : count}
        </span>
      ) : null}
    </Link>
  );
}
