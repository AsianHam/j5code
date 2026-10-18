import type { ConnectionAccess } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { firstRunSetupOffered } from "./firstRunSetup.logic";

const person = (owner: boolean): ConnectionAccess => ({
  kind: "person",
  personId: "human:someone",
  name: "Priya",
  firstOwner: false,
  levels: [{ scope: { kind: "server" }, level: owner ? "owner" : "collaborator" }],
  wide: true,
  owner,
  retiredLinks: null,
});

describe("whether the setup wizard is offered", () => {
  it("is offered to an Owner of the server the client opened first", () => {
    expect(firstRunSetupOffered({ authenticated: true, settled: true, access: person(true) })).toBe(
      true,
    );
  });

  it("is not offered to anyone else, a Collaborator of the whole server included", () => {
    expect(
      firstRunSetupOffered({ authenticated: true, settled: true, access: person(false) }),
    ).toBe(false);
    expect(
      firstRunSetupOffered({ authenticated: true, settled: true, access: { kind: "unknown" } }),
    ).toBe(false);
  });

  it("waits for the server's answer", () => {
    expect(firstRunSetupOffered({ authenticated: true, settled: false, access: null })).toBe(false);
  });

  it("offers nothing on a read that failed: it is not an Owner's answer", () => {
    expect(firstRunSetupOffered({ authenticated: true, settled: true, access: null })).toBe(false);
  });

  it("waits for the first owner's name, which is asked first", () => {
    const nameless = { ...person(true), firstOwner: true, name: null } as ConnectionAccess;
    expect(firstRunSetupOffered({ authenticated: true, settled: true, access: nameless })).toBe(
      false,
    );
  });
});
