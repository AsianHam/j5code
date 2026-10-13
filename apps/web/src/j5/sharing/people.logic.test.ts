import type { SharingOpenLink, SharingPerson } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deviceLabel,
  guestSummary,
  joinLinkRowMeta,
  peopleWithGrantOn,
  removePersonWarning,
  splitPeople,
} from "./people.logic";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400_000;

const thread = (id: string, level: "view" | "collaborate" = "view") =>
  ({ target: { kind: "thread", threadId: id }, level, note: null }) as SharingPerson["grants"][0];
const project = (id: string, level: "view" | "collaborate" = "view") =>
  ({ target: { kind: "project", projectId: id }, level, note: null }) as SharingPerson["grants"][0];
const device = (client: Partial<SharingPerson["devices"][0]["client"]>) =>
  ({ sessionId: "s", client: { deviceType: "desktop", ...client } }) as SharingPerson["devices"][0];

const person = (overrides: Partial<SharingPerson>): SharingPerson =>
  ({
    personId: "p1",
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

describe("a guest's summary line", () => {
  it("puts Collaborate before View and counts devices", () => {
    expect(
      guestSummary(
        person({
          grants: [thread("t1", "collaborate"), thread("t2")],
          devices: [device({}), device({})],
        }),
      ),
    ).toBe("Collaborate on 1 thread · View on 1 thread · 2 devices");
  });

  it("names projects and threads at one level together, and how the person joined", () => {
    expect(
      guestSummary(
        person({
          grants: [project("p"), thread("t")],
          joinedOpenLinkId: "link",
          devices: [device({})],
        }),
      ),
    ).toBe("View on 1 project and 1 thread · joined by link · 1 device");
  });

  it("says when nothing is shared with a person and they have no device yet", () => {
    expect(guestSummary(person({}))).toBe("Nothing shared yet · no devices");
  });
});

describe("a device's label", () => {
  it("gives the kind of device, its system and its browser", () => {
    expect(deviceLabel(device({ os: "Linux", browser: "Chrome" }))).toBe(
      "Desktop · Linux · Chrome",
    );
  });

  it("leaves out what the device did not say", () => {
    expect(deviceLabel(device({ deviceType: "unknown", os: "iOS" }))).toBe("iOS");
    expect(deviceLabel(device({ deviceType: "unknown" }))).toBe("Unknown device");
  });
});

describe("the People page's lists", () => {
  const people = [
    person({ personId: "m", kind: "member", displayName: null }),
    person({ personId: "a", grants: [thread("t1")] }),
    person({ personId: "b", grants: [project("p1", "collaborate"), thread("t2")] }),
  ];

  it("keeps guests and members apart", () => {
    const { guests, members } = splitPeople(people);
    expect(guests.map((guest) => guest.personId)).toEqual(["a", "b"]);
    expect(members.map((member) => member.personId)).toEqual(["m"]);
  });

  it("finds who holds a grant on one project, with the level", () => {
    expect(
      peopleWithGrantOn(people, { kind: "project", projectId: "p1" } as never).map((held) => [
        held.person.personId,
        held.grant.level,
      ]),
    ).toEqual([["b", "collaborate"]]);
    expect(peopleWithGrantOn(people, { kind: "thread", threadId: "t9" } as never)).toEqual([]);
  });
});

describe("a join link's row", () => {
  const link = (joined: ReadonlyArray<string>) =>
    ({
      linkId: "l",
      threadId: "t",
      createdAt: DateTime.makeUnsafe(NOW - DAY),
      expiresAt: DateTime.makeUnsafe(NOW + 6 * DAY),
      revoked: false,
      joined,
    }) as SharingOpenLink;

  it("says the level, the time left and how many joined", () => {
    expect(joinLinkRowMeta(link(["a"]), NOW)).toBe("View · 6 days left · 1 person joined");
    expect(joinLinkRowMeta(link([]), NOW)).toBe("View · 6 days left · nobody joined yet");
  });
});

describe("removing a person", () => {
  it("does not promise that what they already opened is gone at once", () => {
    const warning = removePersonWarning(person({}));
    expect(warning).toContain("up to an hour");
    expect(warning).not.toMatch(/immediately|at once|right away/);
  });
});
