import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { ConnectionAccess, HeldPersonLevel } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { landingFor } from "./landing.logic";

const holding = (levels: ReadonlyArray<HeldPersonLevel>): ConnectionAccess => ({
  kind: "person",
  personId: "human:viewer",
  name: "Dana",
  firstOwner: false,
  levels,
  wide: false,
  owner: false,
  retiredLinks: null,
});

const THREAD = ThreadId.make("thread:one");
const PROJECT = ProjectId.make("project:one");

describe("the first screen", () => {
  it("opens the one thread someone holds", () => {
    expect(
      landingFor(holding([{ scope: { kind: "thread", threadId: THREAD }, level: "viewer" }])),
    ).toEqual({
      kind: "open",
      threadId: THREAD,
    });
  });

  it("lists what someone holds when it is more than one thread", () => {
    expect(
      landingFor(
        holding([
          { scope: { kind: "thread", threadId: THREAD }, level: "viewer" },
          { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
        ]),
      ),
    ).toEqual({ kind: "list", threadIds: [THREAD], projectIds: [PROJECT] });
  });

  it("says nothing is shared once someone has left or lost the last thing", () => {
    expect(landingFor(holding([]))).toEqual({ kind: "nothing" });
  });

  it("is upstream's for anyone at server scope, and before the server answers", () => {
    expect(landingFor(holding([{ scope: { kind: "server" }, level: "viewer" }]))).toEqual({
      kind: "upstream",
    });
    expect(landingFor(null)).toEqual({ kind: "upstream" });
  });
});
