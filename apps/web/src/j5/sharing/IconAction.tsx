import type { ComponentProps, ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * An icon-only row action, as upstream's Settings rows draw one (`EnvironmentRoutesList`,
 * `ThemeSettings`): the label is the button's name and its tooltip.
 */
export function IconAction({
  label,
  tooltip,
  variant = "ghost-muted",
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "aria-label" | "children"> & {
  readonly label: string;
  /** What the tooltip says, when it should differ from the name, such as "Copied". */
  readonly tooltip?: string;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button {...props} size="icon-xs" variant={variant} aria-label={label} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip ?? label}</TooltipPopup>
    </Tooltip>
  );
}
