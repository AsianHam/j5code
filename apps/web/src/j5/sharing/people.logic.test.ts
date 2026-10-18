import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { PeopleEntry, PeopleLink, ScopePerson } from "@t3tools/contracts/j5";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  accessRowsFromScope,
  accessRowView,
  deviceCeiling,
  peopleServerState,
  placeLinks,
  rosterProjectIds,
  linkMeta,
  personNamed,
  raisesToWriting,
  summaryParts,
  widerLabel,
} from "./people.logic";

const THREAD = ThreadId.make("thread:shared");
const PROJECT = ProjectId.make("project:live");
const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 86_400_000;

const person = (overrides: Partial<ScopePerson>): ScopePerson => ({
  personId: null,
  name: "Someone",
  level: "viewer",
  via: [],
  firstOwner: false,
  you: false,
  ...overrides,
});

describe("who has a thread, as the Share dialog lists them", () => {
  const rows = accessRowsFromScope(
    [
      person({
        name: "Priya K.",
        level: "viewer",
        via: [
          {
            via: "thread",
            level: "viewer",
            scope: { kind: "thread", threadId: THREAD },
            scopeTitle: "Replay",
          },
        ],
      }),
      person({
        name: "Dana N.",
        level: "viewer",
        via: [
          {
            via: "project",
            level: "viewer",
            scope: { kind: "project", projectId: PROJECT },
            scopeTitle: "Live test repo",
          },
        ],
      }),
      person({
        name: "Jackson M.",
        level: "owner",
        firstOwner: true,
        you: true,
        via: [{ via: "server", level: "owner", scope: { kind: "server" }, scopeTitle: null }],
      }),
      person({
        name: "Marco R.",
        level: "collaborator",
        via: [
          {
            via: "thread",
            level: "collaborator",
            scope: { kind: "thread", threadId: THREAD },
            scopeTitle: "Replay",
          },
          {
            via: "project",
            level: "viewer",
            scope: { kind: "project", projectId: PROJECT },
            scopeTitle: "Live test repo",
          },
        ],
      }),
    ],
    { kind: "thread", threadId: THREAD },
  );

  it("puts Owners first, then by level", () => {
    expect(rows.map((row) => row.name)).toEqual(["Jackson M.", "Marco R.", "Dana N.", "Priya K."]);
  });

  it("gives a level held on the thread itself a control, and one held wider its place", () => {
    const marco = rows.find((row) => row.name === "Marco R.")!;
    expect(marco.here).toBe("collaborator");
    const dana = rows.find((row) => row.name === "Dana N.")!;
    expect(dana.here).toBeNull();
    expect(widerLabel(dana.wider!)).toBe("Viewer · via Live test repo");
    expect(widerLabel(rows[0]!.wider!)).toBe("Owner · server");
  });
});

describe("raising someone to writing", () => {
  it("is said before it applies, from nothing or from Viewer, up to Owner too", () => {
    expect(raisesToWriting(null, "collaborator")).toBe(true);
    expect(raisesToWriting("viewer", "collaborator")).toBe(true);
    expect(raisesToWriting("collaborator", "owner")).toBe(true);
  });

  it("is not said for a Viewer or for lowering", () => {
    expect(raisesToWriting(null, "viewer")).toBe(false);
    expect(raisesToWriting("owner", "collaborator")).toBe(false);
  });
});

const link = (overrides: Partial<PeopleLink>): PeopleLink => ({
  linkId: "link-1",
  token: "TOKEN",
  kind: "invite",
  scope: { kind: "thread", threadId: THREAD },
  level: "viewer",
  use: "many",
  personId: null,
  personName: null,
  createdAt: DateTime.makeUnsafe(NOW - DAY),
  expiresAt: DateTime.makeUnsafe(NOW + 6 * DAY),
  joined: 2,
  ...overrides,
});

describe("the line under a link", () => {
  it("read as the design says", () => {
    expect(linkMeta(link({}), NOW)).toBe("Anyone with the link · Viewer · 6 days left · 2 joined");
    expect(linkMeta(link({ use: "one", expiresAt: DateTime.makeUnsafe(NOW + 2 * DAY) }), NOW)).toBe(
      "link unused · 2 days left",
    );
  });
});

describe("a typed name that is already someone's", () => {
  const people = [{ personId: "p1", name: "Priya  K." }] as unknown as ReadonlyArray<PeopleEntry>;

  it("matches without case and surrounding or repeated whitespace", () => {
    expect(personNamed(people, "  priya k. ")?.personId).toBe("p1");
    expect(personNamed(people, "Priya")).toBeNull();
  });
});

describe("what a person holds, in a line", () => {
  it("is highest first, with threads at one level counted", () => {
    expect(
      summaryParts([
        { scope: { kind: "thread", threadId: THREAD }, level: "viewer" },
        { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
        { scope: { kind: "thread", threadId: ThreadId.make("thread:other") }, level: "viewer" },
      ]),
    ).toEqual([
      { kind: "project", level: "collaborator", projectId: PROJECT },
      { kind: "threads", level: "viewer", count: 2 },
    ]);
  });
});

describe("one row of who has a thing", () => {
  const row = (overrides: Partial<Parameters<typeof accessRowView>[0]>) =>
    accessRowView({
      personId: "p1",
      name: "Marco R.",
      level: "viewer",
      here: null,
      wider: null,
      firstOwner: false,
      you: false,
      ...overrides,
    });

  it("says the level a wider scope gives, with that scope, over a lower level held here", () => {
    expect(
      row({
        level: "collaborator",
        here: "viewer",
        wider: {
          via: "project",
          level: "collaborator",
          scope: { kind: "project", projectId: PROJECT },
          scopeTitle: "Live test repo",
        },
      }),
    ).toEqual({
      effective: "Collaborator · via Live test repo",
      here: "viewer",
      hereIsOutranked: true,
    });
  });

  it("is the level held here when nothing wider outranks it", () => {
    expect(row({ level: "collaborator", here: "collaborator" })).toEqual({
      effective: "Collaborator",
      here: "collaborator",
      hereIsOutranked: false,
    });
  });

  it("is the level alone for someone who is told no sources", () => {
    expect(row({ level: "collaborator" }).effective).toBe("Collaborator");
  });
});

describe("where the Share dialog lists each link", () => {
  it("puts a further-device link under its person and an invite after the list", () => {
    const device = link({
      linkId: "device",
      kind: "device",
      scope: null,
      level: null,
      use: "one",
      personId: "p1",
    });
    const invite = link({ linkId: "invite", use: "one", personName: "Sam" });
    const elsewhere = link({
      linkId: "elsewhere",
      kind: "device",
      scope: null,
      level: null,
      use: "one",
      personId: "p9",
    });
    const placed = placeLinks({
      links: [device, invite, elsewhere],
      scope: { kind: "thread", threadId: THREAD },
      listed: new Set(["p1"]),
      nowMs: NOW,
    });
    expect(placed.underPerson.get("p1")?.map((one) => one.linkId)).toEqual(["device"]);
    expect(placed.after.map((one) => one.linkId)).toEqual(["invite"]);
  });
});

describe("a device's ceiling, as its People row badges it", () => {
  const device = (ceiling: ReadonlyArray<string> | null) => ({ ceiling });

  it("names what a device paired with fewer permissions keeps", () => {
    expect(deviceCeiling(device(LEVEL_PERMISSIONS.viewer))).toEqual(["View environment"]);
  });

  it("is none for a device paired with every permission, which holds nothing back", () => {
    expect(deviceCeiling(device(LEVEL_PERMISSIONS.owner))).toBeNull();
    expect(deviceCeiling(device(null))).toBeNull();
  });
});

describe("the projects whose people a non-Owner is shown", () => {
  const listed = ["project:a", "project:b", "project:c"];

  it("is each listed project they hold, in the server's order", () => {
    const levels = [
      {
        scope: { kind: "project" as const, projectId: ProjectId.make("project:c") },
        level: "viewer" as const,
      },
      { scope: { kind: "thread" as const, threadId: THREAD }, level: "collaborator" as const },
      {
        scope: { kind: "project" as const, projectId: ProjectId.make("project:a") },
        level: "collaborator" as const,
      },
      {
        scope: { kind: "project" as const, projectId: ProjectId.make("project:gone") },
        level: "viewer" as const,
      },
    ];
    expect(rosterProjectIds(levels, listed)).toEqual(["project:a", "project:c"]);
  });

  it("is every listed project for someone who holds the server", () => {
    expect(rosterProjectIds([{ scope: { kind: "server" }, level: "viewer" }], listed)).toEqual(
      listed,
    );
  });

  it("is none for someone who holds only threads", () => {
    expect(
      rosterProjectIds([{ scope: { kind: "thread", threadId: THREAD }, level: "viewer" }], listed),
    ).toEqual([]);
  });
});

describe("whether People has a server to show", () => {
  it("is starting while a client with its own server lists none, as while a renewal reloads it", () => {
    expect(peopleServerState({ catalogReady: true, listed: 0, hasOwnServer: true })).toBe(
      "starting",
    );
    expect(peopleServerState({ catalogReady: false, listed: 0, hasOwnServer: false })).toBe(
      "starting",
    );
  });

  it("is none only for a client with no server of its own once the list is read", () => {
    expect(peopleServerState({ catalogReady: true, listed: 0, hasOwnServer: false })).toBe("none");
  });

  it("is ready once a server is listed", () => {
    expect(peopleServerState({ catalogReady: false, listed: 1, hasOwnServer: true })).toBe("ready");
  });
});
