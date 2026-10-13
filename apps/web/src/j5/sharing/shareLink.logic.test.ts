import type { AdvertisedEndpoint } from "@t3tools/contracts";
import type { SharingOpenLink, SharingPerson } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { getPairingTokenFromUrl } from "../../pairingUrl";
import {
  activeOpenLinkFor,
  isMarkedShareLink,
  markedAsShareLink,
  guestsMatchingName,
  joinLinkMeta,
  lifetimeLeft,
  linkRouteFromBaseUrl,
  linkRoutesFromEndpoints,
  namedLinkMeta,
  onlyThisMachineCanReach,
} from "./shareLink.logic";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-12T12:00:00Z");

const endpoint = (overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint =>
  ({
    id: "desktop-lan:192.168.1.20",
    label: "192.168.1.20",
    provider: { id: "desktop-core", label: "Desktop" },
    httpBaseUrl: "http://192.168.1.20:3773",
    wsBaseUrl: "ws://192.168.1.20:3773",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "incompatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  }) as AdvertisedEndpoint;

const openLink = (overrides: Partial<SharingOpenLink>): SharingOpenLink =>
  ({
    linkId: "link-1",
    threadId: "thread-1",
    createdAt: DateTime.makeUnsafe(NOW - DAY),
    expiresAt: DateTime.makeUnsafe(NOW + 6 * DAY),
    revoked: false,
    joined: [],
    ...overrides,
  }) as SharingOpenLink;

const person = (overrides: Partial<SharingPerson>): SharingPerson =>
  ({
    personId: "person-1",
    kind: "guest",
    displayName: "Marco R.",
    nameSelfGiven: false,
    joinedOpenLinkId: null,
    createdAt: "2026-10-12T00:00:00Z",
    grants: [],
    devices: [],
    pendingLinks: [],
    ...overrides,
  }) as SharingPerson;

describe("link routes", () => {
  it("puts the credential in a pairing address on the route's own host", () => {
    const [route] = linkRoutesFromEndpoints([endpoint({})]);
    expect(route?.urlFor("SECRET")).toBe("http://192.168.1.20:3773/pair#token=SECRET&j5share=1");
  });

  it("marks a share link where upstream's pairing code still finds the token and nothing else", () => {
    const address = markedAsShareLink(
      "https://app.example/pair?host=https%3A%2F%2Fa.ts.net#token=SECRET",
    );
    expect(isMarkedShareLink(address)).toBe(true);
    expect(getPairingTokenFromUrl(new URL(address))).toBe("SECRET");
    expect(new URL(address).searchParams.get("host")).toBe("https://a.ts.net");
    expect(isMarkedShareLink("https://app.example/pair#token=SECRET")).toBe(false);
  });

  it("sends a named link through the hosted app where the route allows, and a join link never", () => {
    const [route] = linkRoutesFromEndpoints([
      endpoint({
        id: "tailscale-magicdns:openclaw",
        httpBaseUrl: "https://openclaw.tail1234.ts.net",
        reachability: "private-network",
        compatibility: { hostedHttpsApp: "compatible" } as AdvertisedEndpoint["compatibility"],
      }),
    ]);
    expect(new URL(route!.urlFor("SECRET")).searchParams.get("host")).toBe(
      "https://openclaw.tail1234.ts.net",
    );
    expect(route!.directUrlFor("SECRET")).toBe(
      "https://openclaw.tail1234.ts.net/pair#token=SECRET&j5share=1",
    );
    expect(route!.directDetail).toBe("Devices on your private network");
  });

  it("leaves out an address the server is not reachable at now", () => {
    expect(linkRoutesFromEndpoints([endpoint({ status: "unavailable" })])).toEqual([]);
  });

  it("offers a loopback address to copy and never as a QR code", () => {
    const [route] = linkRoutesFromEndpoints([
      endpoint({
        id: "desktop-loopback:127.0.0.1",
        httpBaseUrl: "http://127.0.0.1:3773",
        reachability: "loopback",
      }),
    ]);
    expect(route).toMatchObject({ loopback: true, qrShareable: false });
  });

  it("says only this machine can reach the server when every route is loopback", () => {
    expect(onlyThisMachineCanReach([linkRouteFromBaseUrl("http://localhost:7971")])).toBe(true);
    expect(
      onlyThisMachineCanReach([
        linkRouteFromBaseUrl("http://localhost:7971"),
        linkRouteFromBaseUrl("https://openclaw.tail1234.ts.net"),
      ]),
    ).toBe(false);
  });

  it("treats the address a remote client reached the server at as shareable", () => {
    const route = linkRouteFromBaseUrl("https://openclaw.tail1234.ts.net");
    expect(route).toMatchObject({ loopback: false, qrShareable: true });
    expect(route.urlFor("SECRET")).toBe(
      "https://openclaw.tail1234.ts.net/pair#token=SECRET&j5share=1",
    );
  });
});

describe("how long a link has left", () => {
  it("reads a new seven-day link as seven days", () => {
    expect(lifetimeLeft(NOW + 7 * DAY - 2_000, NOW)).toBe("7 days");
  });

  it("counts hours and minutes below a day", () => {
    expect(lifetimeLeft(NOW + 23 * HOUR + 59 * 60_000, NOW)).toBe("23 hours");
    expect(lifetimeLeft(NOW + HOUR, NOW)).toBe("1 hour");
    expect(lifetimeLeft(NOW + HOUR - 2_000, NOW)).toBe("1 hour");
    expect(lifetimeLeft(NOW + 30_000, NOW)).toBe("1 minute");
  });

  it("has nothing left once it has passed", () => {
    expect(lifetimeLeft(NOW - 1, NOW)).toBeNull();
  });
});

describe("the line under a link", () => {
  it("says a named link works once, when it expires and what it opens", () => {
    expect(
      namedLinkMeta({
        expiresAtMs: NOW + 7 * DAY,
        nowMs: NOW,
        level: "view",
        targetTitle: "Replay fixture: proposed_plan",
      }),
    ).toBe("Works once. Expires in 7 days. View on Replay fixture: proposed_plan.");
  });

  it("counts the people who joined through a join link", () => {
    expect(joinLinkMeta({ expiresAtMs: NOW + 6 * DAY, nowMs: NOW, joined: 2 })).toBe(
      "Expires in 6 days. 2 people have joined.",
    );
    expect(joinLinkMeta({ expiresAtMs: NOW + 6 * DAY, nowMs: NOW, joined: 1 })).toBe(
      "Expires in 6 days. 1 person has joined.",
    );
    expect(joinLinkMeta({ expiresAtMs: NOW + 6 * DAY, nowMs: NOW, joined: 0 })).toBe(
      "Expires in 6 days. Nobody has joined yet.",
    );
  });
});

describe("a thread's join link", () => {
  it("is the one still in force for that thread", () => {
    const links = [
      openLink({ linkId: "revoked", revoked: true }),
      openLink({ linkId: "expired", expiresAt: DateTime.makeUnsafe(NOW - 1) }),
      openLink({ linkId: "other-thread", threadId: "thread-2" as SharingOpenLink["threadId"] }),
      openLink({ linkId: "live" }),
    ];
    expect(activeOpenLinkFor(links, "thread-1", NOW)?.linkId).toBe("live");
  });

  it("is none when every link was revoked or has expired", () => {
    expect(activeOpenLinkFor([openLink({ revoked: true })], "thread-1", NOW)).toBeNull();
  });
});

describe("matching a typed name to someone already here", () => {
  const people = [
    person({}),
    person({ personId: "person-2", displayName: "Priya K." }),
    person({ personId: "member", kind: "member", displayName: "Marco the member" }),
  ];

  it("finds guests by any part of the name, whatever the case", () => {
    expect(guestsMatchingName(people, "  marc").map((match) => match.personId)).toEqual([
      "person-1",
    ]);
  });

  it("offers no one before anything is typed, and never a member", () => {
    expect(guestsMatchingName(people, " ")).toEqual([]);
    expect(guestsMatchingName(people, "member")).toEqual([]);
  });
});
