import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  firstRunSetupOffered,
  pairThroughShareLink,
  rememberPairedThroughShareLink,
  wasPairedThroughShareLink,
} from "./pairedThroughShareLink";

describe("first-run setup and a browser paired through a share link", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const offered = (authenticated: boolean) =>
    firstRunSetupOffered({
      authenticated,
      pairedThroughShareLink: wasPairedThroughShareLink(),
      memberSomewhere: false,
    });

  it("is upstream's answer in a browser never paired through a share link", () => {
    expect(offered(true)).toBe(true);
    expect(offered(false)).toBe(false);
  });

  it("is not offered once the browser pairs through a share link", () => {
    rememberPairedThroughShareLink(true);
    expect(offered(true)).toBe(false);
  });

  it("is offered again when the server says the connection is a member's", () => {
    rememberPairedThroughShareLink(true);
    rememberPairedThroughShareLink(false);
    expect(offered(true)).toBe(true);
  });

  it("is offered to someone paired as a guest here who is a member of another connected server", () => {
    rememberPairedThroughShareLink(true);
    expect(
      firstRunSetupOffered({
        authenticated: true,
        pairedThroughShareLink: wasPairedThroughShareLink(),
        memberSomewhere: true,
      }),
    ).toBe(true);
  });

  it("is upstream's answer where storage cannot be read", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(offered(true)).toBe(true);
  });

  it("is remembered only once the server has paired the browser through the link", async () => {
    await pairThroughShareLink("credential", async () => undefined);
    expect(wasPairedThroughShareLink()).toBe(true);
  });

  it("is left unset when the server refuses the link, as it does a member who opens a guest's", async () => {
    await expect(
      pairThroughShareLink("credential", async () => {
        throw new Error("You are already signed in to this server as a member.");
      }),
    ).rejects.toThrow("already signed in");
    expect(wasPairedThroughShareLink()).toBe(false);
    // The member's first run and first screen stay upstream's.
    expect(offered(true)).toBe(true);
  });
});
