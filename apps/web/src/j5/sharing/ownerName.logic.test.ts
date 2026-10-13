import { describe, expect, it } from "vite-plus/test";

import { serverToAskOwnerNameFor, ownerNameCheck } from "./ownerName.logic";

const server = (id: string, ownerName: string | null | undefined, canManage = true) => ({
  id,
  ownerName,
  canManage,
});

describe("asking the owner of a server for their name at startup", () => {
  it("asks on a server whose owner has no name yet", () => {
    expect(serverToAskOwnerNameFor([server("a", null)], new Set())).toBe("a");
  });

  it("never asks once a name is set, on any device", () => {
    expect(serverToAskOwnerNameFor([server("a", "Jackson M.")], new Set())).toBeNull();
  });

  it("never asks a guest, nor before the server has answered", () => {
    expect(serverToAskOwnerNameFor([server("a", undefined)], new Set())).toBeNull();
  });

  it("never asks a connection that cannot manage access", () => {
    expect(serverToAskOwnerNameFor([server("a", null, false)], new Set())).toBeNull();
  });

  it("does not ask again this session after Not now, and moves on to the next server", () => {
    const servers = [server("a", null), server("b", null)];
    expect(serverToAskOwnerNameFor(servers, new Set())).toBe("a");
    expect(serverToAskOwnerNameFor(servers, new Set(["a"]))).toBe("b");
    expect(serverToAskOwnerNameFor(servers, new Set(["a", "b"]))).toBeNull();
  });
});

describe("a flow that needs the owner's name", () => {
  it("goes ahead with a name this client knows, asking the server nothing", () => {
    expect(ownerNameCheck({ known: "Jackson", listed: undefined, listFailed: false })).toBe(
      "proceed",
    );
    // A connection that was not told (a server from before owners had names) is not asked.
    expect(ownerNameCheck({ known: undefined, listed: undefined, listFailed: false })).toBe(
      "proceed",
    );
  });

  it("checks the server before asking, so a name set on another client is not written over", () => {
    expect(ownerNameCheck({ known: null, listed: undefined, listFailed: false })).toBe("wait");
    expect(ownerNameCheck({ known: null, listed: "Jackson", listFailed: false })).toBe("proceed");
    expect(ownerNameCheck({ known: null, listed: null, listFailed: false })).toBe("ask");
  });

  it("asks when the server cannot be read, and leaves its refusal to decide", () => {
    expect(ownerNameCheck({ known: null, listed: undefined, listFailed: true })).toBe("ask");
  });
});
