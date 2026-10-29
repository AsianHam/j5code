import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { RadarIcon } from "lucide-react";
import { useCallback } from "react";

import { useSidebar } from "../../components/ui/sidebar";
import { cn } from "../../lib/utils";
import { useFleetRefresh } from "./fleetClient";
import { fleetBadgeLabel } from "./fleetPresentation";
import { fleetProblemSummaryAtom } from "./fleetState";

/**
 * The always-mounted rail shares the page's facts and local dispatch deadline.
 */
export function FleetRailEntry({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const summary = useAtomValue(fleetProblemSummaryAtom);
  useFleetRefresh();

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const label = fleetBadgeLabel(summary);
  return (
    <Link
      aria-label={label}
      className={cn(
        // The gap to the inbox entry beside it is this element's own margin, so the upstream
        // wrapper keeps its spacing classes.
        "relative z-10 me-0.5 flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        onBackdrop
          ? "text-white/80 hover:bg-white/15 hover:text-white"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      onClick={closeMobileSidebar}
      title={label}
      to="/fleet"
    >
      <RadarIcon aria-hidden className="size-4" />
      {summary.agentsWithProblems > 0 ? (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {summary.agentsWithProblems}
        </span>
      ) : null}
    </Link>
  );
}
