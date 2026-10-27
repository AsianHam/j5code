import { J5_LINK_DESCRIBE_PATH, J5_SESSION_RENEW_PATH } from "@t3tools/contracts/j5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { describeLink } from "./describeLink";

type Cookie = "none" | "live" | "ended-for-renewal" | "renewed";

/**
 * The two routes as the server answers them, over a browser's one cookie: renewal swaps a
 * session J5 ended for a change of level for a new one, and describe knows only a live session.
 */
const fakeServer = (cookie: { value: Cookie }, unreachable: ReadonlySet<string> = new Set()) =>
  vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (unreachable.has(path)) throw new TypeError("Failed to fetch");
    if (path === J5_SESSION_RENEW_PATH) {
      if (cookie.value === "ended-for-renewal") {
        cookie.value = "renewed";
        return Response.json({ renewed: true });
      }
      return cookie.value === "none"
        ? Response.json({ error: "not_renewable" }, { status: 401 })
        : Response.json({ renewed: false });
    }
    if (path === J5_LINK_DESCRIBE_PATH) {
      const paired = cookie.value === "live" || cookie.value === "renewed";
      return Response.json({
        device: paired
          ? { state: "paired", name: "Sam", samePerson: false }
          : { state: "unpaired" },
      });
    }
    return new Response(null, { status: 404 });
  });

const deviceOf = (answer: { readonly body: unknown }) =>
  (answer.body as { readonly device: { readonly state: string } }).device.state;

describe("describing a link", { concurrent: false }, () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "http://127.0.0.1:3773/pair", origin: "http://127.0.0.1:3773" },
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it("knows a person whose session was ended for a change of level", async () => {
    const cookie = { value: "ended-for-renewal" as Cookie };
    vi.stubGlobal("fetch", fakeServer(cookie));
    const answer = await describeLink("token");
    expect(answer.status).toBe(200);
    expect(deviceOf(answer)).toBe("paired");
  });

  it("describes a browser with no session as new", async () => {
    vi.stubGlobal("fetch", fakeServer({ value: "none" }));
    expect(deviceOf(await describeLink("token"))).toBe("unpaired");
  });

  it("describes the link when renewal cannot be asked", async () => {
    vi.stubGlobal("fetch", fakeServer({ value: "live" }, new Set([J5_SESSION_RENEW_PATH])));
    expect(deviceOf(await describeLink("token"))).toBe("paired");
  });

  it("says nothing of a link when the server cannot be asked", async () => {
    vi.stubGlobal(
      "fetch",
      fakeServer({ value: "live" }, new Set([J5_SESSION_RENEW_PATH, J5_LINK_DESCRIBE_PATH])),
    );
    expect(await describeLink("token")).toEqual({ status: null, body: null });
  });
});
