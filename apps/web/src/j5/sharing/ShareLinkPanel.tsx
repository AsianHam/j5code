import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useMemo, useState } from "react";

import { selectQrEndpointOption } from "../../components/settings/ConnectionsSettings.logic";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { QRCodeSvg } from "../../components/ui/qr-code";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useUiStateStore } from "../../uiStateStore";
import {
  linkRouteFromBaseUrl,
  linkRoutesFromEndpoints,
  onlyThisMachineCanReach,
  type LinkRoute,
} from "./shareLink.logic";

/**
 * The addresses a link to this server can use. The desktop app knows every address its own
 * server advertises; any other client knows only the one it reached the server at. Nothing is
 * opened to make a link work (Shared server AC22).
 */
function useLinkRoutes(environmentId: EnvironmentId): ReadonlyArray<LinkRoute> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const advertised = useEnvironmentQuery(
    isElectron && environmentId === primaryEnvironmentId ? desktopNetworkAccessStateAtom : null,
  );
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  return useMemo(() => {
    const routes = linkRoutesFromEndpoints(advertised.data?.advertisedEndpoints ?? []);
    if (routes.length > 0) return routes;
    return [linkRouteFromBaseUrl(baseUrl ?? window.location.origin)];
  }, [advertised.data, baseUrl]);
}

/**
 * A link to send to someone: the route it travels by, the address to copy, and a QR code for a
 * route another device can reach. `secret` is a share link's credential or a join link's token.
 */
export function ShareLinkPanel({
  environmentId,
  secret,
  meta,
  whoCannotOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly secret: string;
  readonly meta: ReactNode;
  /** Who the loopback-only warning names: the person, or "People" for a join link. */
  readonly whoCannotOpen: string;
}) {
  const routes = useLinkRoutes(environmentId);
  const defaultRouteKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const [routeId, setRouteId] = useState<string | null>(null);
  const route = selectQrEndpointOption(routes, routeId, defaultRouteKey);
  const url = route?.urlFor(secret) ?? "";
  const localOnly = onlyThisMachineCanReach(routes);
  // A browser on plain HTTP has no clipboard; the address is shown whole to copy by hand.
  const [showWhole, setShowWhole] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "link",
    onCopy: () => toastManager.add({ type: "success", title: "Link copied" }),
    onError: () => setShowWhole(true),
  });

  return (
    <>
      {localOnly ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>
              <strong className="font-semibold">Only this machine can reach this server.</strong>{" "}
              {whoCannotOpen} will not be able to open the link from another computer. Turn on
              network access in Settings › Connections, or share over your tailnet.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {routes.length > 1 ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Reach this server via
          </span>
          <Select value={route?.id ?? ""} onValueChange={(value) => setRouteId(value)}>
            <SelectTrigger aria-label="Reach this server via">
              <SelectValue>
                {route === null ? "" : `${route.label} · ${route.detail.toLowerCase()}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {routes.map((option) => (
                <SelectItem hideIndicator key={option.id} value={option.id}>
                  <span className="flex min-w-0 flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.detail}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      ) : null}
      {showWhole ? (
        <Textarea
          readOnly
          aria-label="Link"
          value={url}
          rows={3}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 py-1.5 pr-1.5 pl-2.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                  {url}
                </code>
              }
            />
            <TooltipPopup side="top">{url}</TooltipPopup>
          </Tooltip>
          <Button size="xs" variant="outline" onClick={() => copyToClipboard(url, undefined)}>
            {isCopied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{meta}</p>
      {route !== null && route.qrShareable ? (
        <div className="w-fit self-center rounded-xl bg-white p-3">
          <QRCodeSvg
            value={url}
            size={148}
            level="M"
            marginSize={1}
            title="Link — scan to open on another device"
          />
        </div>
      ) : null}
    </>
  );
}
