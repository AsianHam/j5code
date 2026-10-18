import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { permissionNoticeApplies } from "./upstreamNotices.logic";

const person = {
  kind: "person" as const,
  personId: "human:priya",
  name: "Priya",
  firstOwner: false,
  levels: [{ scope: { kind: "server" as const }, level: "viewer" as const }],
  wide: false,
  owner: false,
  retiredLinks: null,
};

describe("upstream's notice to pair again", () => {
  it("is not shown to a person, whose permissions follow their level", () => {
    expect(permissionNoticeApplies(AsyncResult.success(person))).toBe(false);
  });

  it("is not shown to a device the server will ask about", () => {
    expect(permissionNoticeApplies(AsyncResult.success({ kind: "unknown" as const }))).toBe(false);
  });

  it("waits for the server's answer", () => {
    expect(permissionNoticeApplies(AsyncResult.initial())).toBe(false);
  });

  it("stays upstream's for a server from before people and for a session that is no person's", () => {
    expect(permissionNoticeApplies(AsyncResult.success(null))).toBe(true);
    expect(permissionNoticeApplies(AsyncResult.success({ kind: "service" as const }))).toBe(true);
  });
});
