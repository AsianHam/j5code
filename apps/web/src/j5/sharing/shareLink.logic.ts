import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { markedAsShareLink, type SharingLinkLifetime } from "@t3tools/contracts/j5";

import {
  isQrShareableEndpoint,
  type QrEndpointOption,
} from "../../components/settings/ConnectionsSettings.logic";
import { isLoopbackHostname } from "../../environments/primary/target";
import { resolveDesktopPairingUrl } from "../../components/settings/pairingUrls";

/** How long a link stays usable, as the Share dialog offers it (AC31). */
export const LINK_LIFETIMES: ReadonlyArray<{
  readonly id: SharingLinkLifetime;
  readonly label: string;
}> = [
  { id: "1h", label: "1 hour" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];
export type LinkLifetime = SharingLinkLifetime;
export const DEFAULT_LINK_LIFETIME: LinkLifetime = "7d";

/** What a person is told when a name is not one the server will take, before it is sent. */
export const NAME_NOT_USABLE =
  "Use a name of one line, up to 80 characters, with no invisible characters, no square or angle brackets, and no level in parentheses such as (owner).";
/** What a person is told when the name they chose is someone else's on this server. */
export const NAME_IN_USE = "That name is already in use on this server. Choose another.";

/**
 * One way a link can reach the server: an address the server is already reachable at (AC38).
 * A link always opens on the server itself, never in the hosted app, whose pairing form takes an
 * upstream pairing credential and cannot ask what a J5 link opens or who is joining.
 */
export interface LinkRoute extends QrEndpointOption {
  readonly label: string;
  readonly detail: string;
  /** Only this machine can open a link over this route. */
  readonly loopback: boolean;
  /** The address of the join page for a link's token. */
  readonly urlFor: (token: string) => string;
}

const hostnameOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
};

const reachabilityHint = (reachability: AdvertisedEndpoint["reachability"]) => {
  switch (reachability) {
    case "lan":
      return "Devices on the same network";
    case "private-network":
      return "Devices on your private network";
    case "public":
      return "Reachable from anywhere";
    case "loopback":
      return "Clients on this machine";
  }
};

const endpointPreferenceKey = (endpoint: AdvertisedEndpoint) => {
  if (endpoint.id.startsWith("desktop-loopback:")) return "desktop-core:loopback:http";
  if (endpoint.id.startsWith("desktop-lan:")) return "desktop-core:lan:http";
  if (endpoint.id.startsWith("tailscale-ip:")) return "tailscale:ip:http";
  if (endpoint.id.startsWith("tailscale-magicdns:")) return "tailscale:magicdns:https";
  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // A malformed custom endpoint still gets a stable key.
  }
  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
};

/** The routes the desktop app advertises for its own server, as upstream's share panel lists them. */
export function linkRoutesFromEndpoints(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
): ReadonlyArray<LinkRoute> {
  return endpoints
    .filter((endpoint) => endpoint.status !== "unavailable")
    .map((endpoint) => ({
      id: endpoint.id,
      preferenceKey: endpointPreferenceKey(endpoint),
      qrShareable: isQrShareableEndpoint(endpoint),
      label: endpoint.label,
      detail: reachabilityHint(endpoint.reachability),
      loopback: endpoint.reachability === "loopback",
      urlFor: (token) => markedAsShareLink(resolveDesktopPairingUrl(endpoint.httpBaseUrl, token)),
    }));
}

/** The one route a client knows when nothing advertises others: the address it reached the server at. */
export function linkRouteFromBaseUrl(baseUrl: string): LinkRoute {
  const hostname = hostnameOf(baseUrl);
  const loopback = isLoopbackHostname(hostname);
  return {
    id: `base:${baseUrl}`,
    preferenceKey: `base:${baseUrl}`,
    qrShareable: !loopback,
    label: hostname === "" ? baseUrl : hostname,
    detail: loopback ? "Clients on this machine" : "The address this client uses",
    loopback,
    urlFor: (token) => markedAsShareLink(resolveDesktopPairingUrl(baseUrl, token)),
  };
}

/** No route leaves this machine, so a link made now cannot be opened from another computer. */
export const onlyThisMachineCanReach = (routes: ReadonlyArray<LinkRoute>) =>
  routes.length > 0 && routes.every((route) => route.loopback);

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** "7 days", "23 hours", "40 minutes": how long until a link stops working, in whole units. */
export function lifetimeLeft(expiresAtMs: number, nowMs: number): string | null {
  // Rounded up, so a link made for an hour reads "1 hour" and not "59 minutes" a moment later.
  const minutes = Math.ceil((expiresAtMs - nowMs) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute", "minutes")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, "hour", "hours")}`;
  // A link made for seven days reads "7 days" for the first hour of its life, not "6 days".
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "day", "days")}`;
}

/** The first one or two letters a person's avatar shows. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0]?.[0] ?? "?");
  return letters.toUpperCase();
}
