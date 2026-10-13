import type { SharingThreadGuest, SharingThreadPeople } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  chipLabel,
  memberName,
  othersLabel,
  removeFromThreadWarning,
  threadPeopleView,
} from "./threadPeople.logic";

const guest = (
  displayName: string,
  via: ReadonlyArray<"thread" | "ancestor" | "project">,
  overrides: Partial<SharingThreadGuest> = {},
): SharingThreadGuest => ({
  personId: displayName,
  displayName,
  level: "view",
  grants: via.map((reach) => ({ via: reach, level: "view" as const })),
  you: false,
  nameSelfGiven: false,
  joinedByOpenLink: false,
  ...overrides,
});
const people = (guests: ReadonlyArray<SharingThreadGuest>): SharingThreadPeople => ({
  members: [{ personId: "owner", displayName: null }],
  guests,
  openLinks: [],
});

describe("who reaches a thread", () => {
  const answer = people([
    guest("direct", ["thread"]),
    guest("both", ["project", "thread"]),
    guest("project", ["project"]),
    guest("agent's parent", ["ancestor"]),
    guest("me", ["thread"], { you: true, personId: null }),
  ]);
  const view = threadPeopleView(answer);

  it("lists a guest with a grant on the thread under the thread, whatever else covers them", () => {
    expect(view.direct.map((held) => held.displayName)).toEqual(["direct", "both", "me"]);
    expect(view.throughProject.map((held) => held.displayName)).toEqual(["project"]);
    expect(view.throughAncestor.map((held) => held.displayName)).toEqual(["agent's parent"]);
  });

  it("knows which guest is asking", () => {
    expect(view.you?.displayName).toBe("me");
  });

  it("counts every guest for the chip, and everyone without a grant on the thread as others", () => {
    expect(chipLabel(answer)).toBe("5 people");
    expect(othersLabel(view)).toBe("3 others");
  });

  it("shows no chip for a thread only members reach", () => {
    expect(chipLabel(people([]))).toBeNull();
    expect(othersLabel(threadPeopleView(people([])))).toBe("1 other");
  });

  it("words a member the server has no name for", () => {
    expect(memberName({ personId: "owner", displayName: null })).toBe("A member of this server");
    expect(memberName({ personId: "owner", displayName: "Jackson M." })).toBe("Jackson M.");
  });
});

describe("removing a guest from a thread", () => {
  it("says it leaves their list when nothing else covers them", () => {
    expect(removeFromThreadWarning(guest("Marco", ["thread"]), "the plan")).toBe(
      "Remove Marco from the plan? It leaves their list. An image or file they already opened can stay readable for up to an hour.",
    );
  });

  it("says they will still reach it when the project is shared with them too", () => {
    const warning = removeFromThreadWarning(guest("Marco", ["thread", "project"]), "the plan");
    expect(warning).toContain("will still reach it through its project");
    expect(warning).not.toContain("leaves their list");
  });
});
