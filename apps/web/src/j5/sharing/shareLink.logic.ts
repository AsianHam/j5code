import type { AdvertisedEndpoint } from "@t3tools/contracts";
import type {
  SharingGrantLevel,
  SharingLinkLifetime,
  SharingOpenLink,
  SharingPerson,
} from "@t3tools/contracts/j5";

import {
  isQrShareableEndpoint,
  type QrEndpointOption,
} from "../../components/settings/ConnectionsSettings.logic";
import { isLoopbackHostname } from "../../environments/primary/target";
import {
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "../../components/settings/pairingUrls";

/** How long a link stays usable, as the Share and Join link dialogs offer it. */
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
  "Use a name of one line, up to 80 characters, with no invisible characters or square brackets.";
/** What a person is told when the name they chose is someone else's on this server. */
export const NAME_IN_USE = "That name is already in use on this server. Choose another.";

const LEVEL_LABELS: Record<SharingGrantLevel, string> = {
  view: "View",
  collaborate: "Collaborate",
};
export const levelLabel = (level: SharingGrantLevel) => LEVEL_LABELS[level];

/** One way a link can reach the server: an address the server is already reachable at (AC22). */
export interface LinkRoute extends QrEndpointOption {
  readonly label: string;
  readonly detail: string;
  /** Only this machine can open a link over this route. */
  readonly loopback: boolean;
  readonly urlFor: (credential: string) => string;
}

const hostnameOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
};

const isHostedUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
};

/**
 * The mark J5 puts on every share link it makes, in the fragment beside upstream's `token`. The
 * page that opens the link reads it to know the link is a guest's before asking the server
 * anything, so a share link that no longer works is told apart from a pairing token the server
 * simply does not describe. Upstream reads the fragment as parameters and takes only `token`.
 */
export const SHARE_LINK_MARK = "j5share";

/** A pairing address marked as a share link's. */
export function markedAsShareLink(address: string): string {
  const url = new URL(address);
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  fragment.set(SHARE_LINK_MARK, "1");
  url.hash = fragment.toString();
  return url.toString();
}

/** Whether an address carries J5's mark. */
export function isMarkedShareLink(address: string): boolean {
  try {
    return new URLSearchParams(new URL(address).hash.replace(/^#/u, "")).has(SHARE_LINK_MARK);
  } catch {
    return false;
  }
}

// The four helpers below follow upstream's Connections settings, where they are private to
// `ConnectionsSettings.tsx`: which address a link uses, how it is described, and which one a
// saved default names. Reread them there when upstream changes how it picks a route.
const endpointUrl = (endpoint: AdvertisedEndpoint, credential: string) =>
  endpoint.compatibility.hostedHttpsApp === "compatible"
    ? (resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential))
    : resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);

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
      detail: isHostedUrl(endpointUrl(endpoint, "x"))
        ? "Opens the hosted app, no install needed"
        : reachabilityHint(endpoint.reachability),
      loopback: endpoint.reachability === "loopback",
      urlFor: (credential) => markedAsShareLink(endpointUrl(endpoint, credential)),
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
    urlFor: (credential) => markedAsShareLink(resolveDesktopPairingUrl(baseUrl, credential)),
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

/** The line under a named person's link: "Works once. Expires in 7 days. View on <title>." */
export function namedLinkMeta(input: {
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly level: SharingGrantLevel | null;
  readonly targetTitle: string | null;
}): string {
  const left = lifetimeLeft(input.expiresAtMs, input.nowMs);
  return [
    "Works once.",
    left === null ? "Expired." : `Expires in ${left}.`,
    ...(input.level !== null && input.targetTitle !== null
      ? [`${levelLabel(input.level)} on ${input.targetTitle}.`]
      : []),
  ].join(" ");
}

/** The line under an active join link: "Expires in 6 days. 2 people have joined." */
export function joinLinkMeta(input: {
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly joined: number;
}): string {
  const left = lifetimeLeft(input.expiresAtMs, input.nowMs);
  const joined =
    input.joined === 0
      ? "Nobody has joined yet."
      : `${input.joined} ${plural(input.joined, "person has", "people have")} joined.`;
  return `${left === null ? "Expired." : `Expires in ${left}.`} ${joined}`;
}

/** Whether new people can still join through an open link. */
export const openLinkIsActive = (link: SharingOpenLink, nowMs: number) =>
  !link.revoked && link.expiresAt.epochMilliseconds > nowMs;

/** The join link a thread has now, the one with the longest left to run when there are several. */
export function activeOpenLinkFor(
  links: ReadonlyArray<SharingOpenLink>,
  threadId: string,
  nowMs: number,
): SharingOpenLink | null {
  return (
    links
      .filter((link) => link.threadId === threadId && openLinkIsActive(link, nowMs))
      .toSorted(
        (left, right) => right.expiresAt.epochMilliseconds - left.expiresAt.epochMilliseconds,
      )[0] ?? null
  );
}

/** The guests whose name holds what was typed; an existing person is shared with, not invited. */
export function guestsMatchingName(
  people: ReadonlyArray<SharingPerson>,
  typed: string,
): ReadonlyArray<SharingPerson> {
  const query = typed.trim().toLowerCase();
  if (query === "") return [];
  return people.filter(
    (person) => person.kind === "guest" && (person.displayName ?? "").toLowerCase().includes(query),
  );
}

/** The first one or two letters a person's avatar shows. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0]?.[0] ?? "?");
  return letters.toUpperCase();
}
