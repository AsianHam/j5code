import type { EnvironmentId } from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

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
 * opened to make a link work (People and access AC38).
 */
export function useLinkRoutes(environmentId: EnvironmentId): ReadonlyArray<LinkRoute> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const advertised = useEnvironmentQuery(
    isElectron && environmentId === primaryEnvironmentId ? desktopNetworkAccessStateAtom : null,
  );
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const routes = linkRoutesFromEndpoints(advertised.data?.advertisedEndpoints ?? []);
  if (routes.length > 0) return routes;
  return [linkRouteFromBaseUrl(baseUrl ?? window.location.origin)];
}

/** The address a link has over the route this client would offer first, for a one-click copy. */
export function useLinkAddress(environmentId: EnvironmentId): (token: string) => string | null {
  const routes = useLinkRoutes(environmentId);
  const defaultRouteKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const route = selectQrEndpointOption(routes, null, defaultRouteKey);
  return (token) => (route === null ? null : route.urlFor(token));
}

/**
 * A link to send to someone: the route it travels by, the address to copy, and a QR code for a
 * route another device can reach. `token` is the link's own, kept by the server so it can be
 * copied again (AC41).
 */
export function ShareLinkPanel({
  environmentId,
  token,
  meta,
  whoCannotOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly token: string;
  readonly meta: ReactNode;
  /** Who the loopback-only warning names: the person, or "People" for a link for many. */
  readonly whoCannotOpen: string;
}) {
  const routes = useLinkRoutes(environmentId);
  const defaultRouteKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const [routeId, setRouteId] = useState<string | null>(null);
  const route = selectQrEndpointOption(routes, routeId, defaultRouteKey);
  const url = route === null ? "" : route.urlFor(token);
  const detailOf = (option: LinkRoute) => option.detail;
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
                {route === null ? "" : `${route.label} · ${detailOf(route).toLowerCase()}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {routes.map((option) => (
                <SelectItem hideIndicator key={option.id} value={option.id}>
                  <span className="flex min-w-0 flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">{detailOf(option)}</span>
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
            <CopyIcon />
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
            title="Link: scan to open on another device"
          />
        </div>
      ) : null}
    </>
  );
}
