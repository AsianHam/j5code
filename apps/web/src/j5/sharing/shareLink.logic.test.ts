import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { isMarkedShareLink, markedAsShareLink } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { getPairingTokenFromUrl } from "../../pairingUrl";
import {
  lifetimeLeft,
  linkRouteFromBaseUrl,
  linkRoutesFromEndpoints,
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

  it("opens a link on the server itself, never in the hosted app", () => {
    const [route] = linkRoutesFromEndpoints([
      endpoint({
        id: "tailscale-magicdns:openclaw",
        httpBaseUrl: "https://openclaw.tail1234.ts.net",
        reachability: "private-network",
        compatibility: { hostedHttpsApp: "compatible" } as AdvertisedEndpoint["compatibility"],
      }),
    ]);
    expect(route!.urlFor("SECRET")).toBe(
      "https://openclaw.tail1234.ts.net/pair#token=SECRET&j5share=1",
    );
    expect(route!.detail).toBe("Devices on your private network");
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
