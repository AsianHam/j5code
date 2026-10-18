import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { PeopleEntry, PeopleLink, ScopePerson } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  accessRowsFromScope,
  linkMeta,
  linksOn,
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

describe("the links in force on a thing", () => {
  it("are those made for it that have not expired", () => {
    const links = [
      link({ linkId: "here" }),
      link({ linkId: "expired", expiresAt: DateTime.makeUnsafe(NOW - 1) }),
      link({ linkId: "project", scope: { kind: "project", projectId: PROJECT } }),
      link({ linkId: "device", kind: "device", scope: null, level: null, use: "one" }),
    ];
    expect(
      linksOn(links, { kind: "thread", threadId: THREAD }, NOW).map((one) => one.linkId),
    ).toEqual(["here"]);
  });

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
