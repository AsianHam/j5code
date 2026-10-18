import type { LinkDescription } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  asYourselfWords,
  invitationFor,
  joinPageState,
  joinRefusal,
  joinView,
  refusalWords,
} from "./joinPage.logic";

const link = (overrides: Partial<LinkDescription>): LinkDescription => ({
  serverName: "openclaw",
  kind: "invite",
  use: "one",
  opens: {
    kind: "thread",
    threadTitle: "Replay fixture: proposed_plan",
    projectTitle: "Live test repo",
    projectIcon: null,
    projectFaviconUrl: null,
  },
  level: "collaborator",
  personName: "Marco R.",
  device: { state: "unpaired" },
  expiresAt: DateTime.makeUnsafe("2026-10-25T00:00:00Z"),
  ...overrides,
});

const say = (description: LinkDescription) => {
  const words = invitationFor(description);
  return `${words.before}${words.title ?? ""}${words.after} [${words.level}].${words.viewerNote === null ? "" : ` ${words.viewerNote}`}`;
};

describe("what the join page says a link opens", () => {
  it("names the thread, its project and the level", () => {
    expect(say(link({}))).toBe(
      "You have been invited to Replay fixture: proposed_plan in Live test repo as a [Collaborator].",
    );
  });

  it("tells a Viewer what they can do", () => {
    expect(say(link({ level: "viewer", use: "many", personName: null }))).toBe(
      "You have been invited to Replay fixture: proposed_plan in Live test repo as a [Viewer]. You can read it and watch the agent work; you cannot send it anything.",
    );
  });

  it("names the server for a link to all of it", () => {
    expect(say(link({ opens: { kind: "server" }, level: "owner" }))).toBe(
      "You have been invited to openclaw as an [Owner].",
    );
  });
});

describe("what the join page asks", () => {
  it("offers the name an Owner gave, to confirm or change", () => {
    expect(joinView(link({}))).toEqual({ kind: "name", prefill: "Marco R.", placeholder: null });
  });

  it("asks someone opening a link for many what to call them", () => {
    expect(joinView(link({ use: "many", personName: null, level: "viewer" }))).toEqual({
      kind: "name",
      prefill: "",
      placeholder: "What should people and agents on openclaw call you?",
    });
  });

  it("lets a browser already on the server join a link for many as itself", () => {
    const description = link({
      use: "many",
      personName: null,
      level: "viewer",
      device: { state: "paired", name: "Priya K.", samePerson: false },
    });
    expect(joinView(description)).toEqual({ kind: "as-yourself", name: "Priya K." });
    expect(asYourselfWords(description, "Priya K.")).toBe(
      "You are already on openclaw as Priya K. This link adds Replay fixture: proposed_plan as a Viewer.",
    );
  });

  it("refuses a link for one person on a device that is someone else's", () => {
    expect(
      joinView(link({ device: { state: "paired", name: "Priya K.", samePerson: false } })),
    ).toEqual({ kind: "someone-elses", name: "Marco R." });
  });

  it("refuses a link for one person on a device that is already theirs", () => {
    expect(
      joinView(link({ device: { state: "paired", name: "Marco R.", samePerson: true } })),
    ).toEqual({
      kind: "already-yours",
    });
  });
});

describe("what the pairing page does with a link", () => {
  it("hands an ordinary pairing link to upstream without asking", () => {
    expect(joinPageState({ marked: false, status: 200, body: link({}) })).toEqual({
      kind: "upstream",
    });
  });

  it("shows one state for every link that does not work", () => {
    expect(joinPageState({ marked: true, status: 404, body: { error: "link_refused" } })).toEqual({
      kind: "dead",
    });
  });

  it("leaves a link to upstream when the server cannot be asked", () => {
    expect(joinPageState({ marked: true, status: null, body: null })).toEqual({ kind: "upstream" });
  });
});

describe("a refused join", () => {
  it("says a name is someone else's in the server's name", () => {
    const refusal = joinRefusal(409, { error: "name_taken" });
    expect(refusal).toBe("name_taken");
    expect(refusalWords(refusal!, link({}))).toBe("Someone on openclaw already has that name.");
  });

  it("does not take an unknown refusal for one it knows", () => {
    expect(joinRefusal(409, { error: "something_new" })).toBeNull();
  });
});
