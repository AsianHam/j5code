import type { ConnectionAccess } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { serverToAskNameFor } from "./nameDialog.logic";

const firstOwner = (name: string | null): ConnectionAccess => ({
  kind: "person",
  personId: "human:owner",
  name,
  firstOwner: true,
  levels: [{ scope: { kind: "server" }, level: "owner" }],
  wide: true,
  owner: true,
  retiredLinks: null,
});

describe("which server asks a person their name", () => {
  it("asks a device the server cannot place to say whose it is", () => {
    expect(serverToAskNameFor([{ id: "a", access: { kind: "unknown" } }])).toEqual({
      id: "a",
      kind: "claim",
    });
  });

  it("asks the first owner for a name until they have one", () => {
    expect(serverToAskNameFor([{ id: "a", access: firstOwner(null) }])).toEqual({
      id: "a",
      kind: "first-owner",
    });
    expect(serverToAskNameFor([{ id: "a", access: firstOwner("Jackson") }])).toBeNull();
  });

  it("waits for a server that has not answered, and asks the next one that needs it", () => {
    expect(
      serverToAskNameFor([
        { id: "a", access: null },
        { id: "b", access: firstOwner("Jackson") },
        { id: "c", access: { kind: "unknown" } },
      ]),
    ).toEqual({ id: "c", kind: "claim" });
  });
});
