import { useNavigate } from "@tanstack/react-router";
import { RadarIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";

export function useFleetPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  return [
    {
      kind: "action",
      value: "action:j5-fleet",
      title: "Open fleet",
      searchTerms: ["fleet", "agents", "crews", "roster"],
      icon: <RadarIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/fleet" });
      },
    },
  ];
}
