import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { RadarIcon } from "lucide-react";

import { useSidebar } from "../../components/ui/sidebar";
import { cn } from "../../lib/utils";
import { fleetSourcesAtom } from "../state";
import { countFleetAlerts } from "./fleet.logic";
import { mergeFleetSources, useFleetRefresh } from "./fleetClient";

/**
 * Rail entry for the Roster (SB6). The badge counts agents that owe a reply across every
 * connected environment, a measured fact, so hidden Background agents stay visible somewhere
 * even though the sidebar no longer lists them.
 */
export function FleetRailEntry({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const sources = useAtomValue(fleetSourcesAtom);
  useFleetRefresh();
  const known = sources.sources.filter((source) => source.data !== null);
  const alerts = known.length === 0 ? null : countFleetAlerts(mergeFleetSources(sources));

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const label =
    alerts === null || alerts === 0 ? "Open fleet" : `Open fleet, ${alerts} agents owe a reply`;
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
      {alerts !== null && alerts > 0 ? (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {alerts}
        </span>
      ) : null}
    </Link>
  );
}
