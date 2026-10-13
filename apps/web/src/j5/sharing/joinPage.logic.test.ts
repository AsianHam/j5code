import type { SharingLinkDescription } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  invitationFor,
  invitationList,
  joinPageState,
  landingFor,
  guestIsLeftOnNothing,
} from "./joinPage.logic";

const noIcon = { projectIcon: null, projectFaviconUrl: null };
const thread = (threadTitle: string, projectTitle: string | null = "Live test repo") =>
  ({ kind: "thread", threadTitle, projectTitle, level: "view", ...noIcon }) as const;
const project = (projectTitle: string) =>
  ({ kind: "project", projectTitle, level: "view", ...noIcon }) as const;
const link = (overrides: Partial<SharingLinkDescription>): SharingLinkDescription => ({
  expiresAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
  kind: "person",
  serverName: "openclaw",
  personName: "Marco R.",
  opens: [],
  ...overrides,
});
const say = (description: SharingLinkDescription) => {
  const { before, title, after } = invitationFor(description);
  return `${before}${title ?? ""}${after}`;
};

describe("what the join page says a link opens", () => {
  it("names the one thread, its project and the server", () => {
    expect(say(link({ opens: [thread("Replay fixture: proposed_plan")] }))).toBe(
      "You have been invited to Replay fixture: proposed_plan in Live test repo on openclaw.",
    );
  });

  it("names a project by itself", () => {
    expect(say(link({ opens: [project("Live test repo")] }))).toBe(
      "You have been invited to Live test repo on openclaw.",
    );
  });

  it("counts several, threads before projects, and lists them", () => {
    const several = link({
      opens: [thread("a"), project("Website"), thread("b"), thread("c", null)],
    });
    expect(say(several)).toBe("You have been invited to 3 threads and 1 project on openclaw.");
    expect(invitationList(several)).toEqual({
      lines: [
        { title: "a", detail: "Live test repo", icon: null, faviconUrl: null },
        { title: "Website", detail: null, icon: null, faviconUrl: null },
        { title: "b", detail: "Live test repo", icon: null, faviconUrl: null },
        { title: "c", detail: null, icon: null, faviconUrl: null },
      ],
      more: 0,
    });
  });

  it("carries the icon a person chose for a project, and its favicon link", () => {
    const several = link({
      opens: [
        { ...thread("a"), projectIcon: { kind: "emoji", emoji: "🚀" } },
        { ...project("Website"), projectFaviconUrl: "/api/j5/sharing/icon?k=signed" },
      ],
    });
    expect(invitationList(several).lines.map((line) => [line.icon, line.faviconUrl])).toEqual([
      [{ kind: "emoji", emoji: "🚀" }, null],
      [null, "/api/j5/sharing/icon?k=signed"],
    ]);
  });

  it("lists five and says how many more", () => {
    const many = link({ opens: Array.from({ length: 7 }, (_, index) => thread(`t${index}`)) });
    const list = invitationList(many);
    expect(list.lines).toHaveLength(5);
    expect(list.more).toBe(2);
  });

  it("says so when nothing is shared with the person yet", () => {
    expect(say(link({}))).toBe(
      "Nothing is shared with you on openclaw yet. Once you join, a member can share a thread or project with you and it will appear on its own.",
    );
  });

  it("tells someone opening a join link that they will read and not send", () => {
    expect(
      say(
        link({ kind: "open", personName: null, opens: [thread("Replay fixture: proposed_plan")] }),
      ),
    ).toBe(
      "You have been invited to Replay fixture: proposed_plan in Live test repo on openclaw. You can read it and watch the agent work; you cannot send it anything.",
    );
  });
});

describe("what the page does with the lookup's answer", () => {
  it("shows what a working share link opens", () => {
    const description = link({ opens: [project("Live test repo")] });
    expect(joinPageState({ marked: true, status: 200, body: description })).toEqual({
      kind: "described",
      description,
    });
  });

  it("says a share link does not work when the lookup gives nothing, named or join alike", () => {
    expect(joinPageState({ marked: true, status: 404, body: {} })).toEqual({ kind: "dead" });
  });

  it("leaves a link without J5's mark to upstream's page, whatever a lookup would say", () => {
    expect(joinPageState({ marked: false, status: 404, body: {} })).toEqual({ kind: "upstream" });
    expect(joinPageState({ marked: false, status: 200, body: link({}) })).toEqual({
      kind: "upstream",
    });
  });

  it("leaves everything to upstream's page when the server cannot be asked", () => {
    expect(joinPageState({ marked: true, status: null, body: null })).toEqual({ kind: "upstream" });
    expect(joinPageState({ marked: true, status: 200, body: "<html>" })).toEqual({
      kind: "upstream",
    });
  });
});

describe("the first screen", () => {
  it("draws upstream's landing for a member at once, before the server has answered", () => {
    expect(landingFor({ kind: null, pairedThroughShareLink: false })).toBe("upstream");
  });

  it("keeps drawing upstream's landing when the answer is a member's, or never comes", () => {
    // A request that fails is answered as a member's: a server without sharing has no guests.
    expect(landingFor({ kind: "member", pairedThroughShareLink: false })).toBe("upstream");
    expect(landingFor({ kind: "member", pairedThroughShareLink: true })).toBe("upstream");
  });

  it("holds the frame only for a browser that was paired through a share link", () => {
    expect(landingFor({ kind: null, pairedThroughShareLink: true })).toBe("hold");
  });

  it("is the guest's own once the server says so", () => {
    expect(landingFor({ kind: "guest", pairedThroughShareLink: false })).toBe("guest");
  });
});

describe("a guest whose last share is taken away while they have it open", () => {
  const onThread = { isGuest: true, onThreadAddress: true, listed: true, threadCount: 0 };

  it("is taken off the thread's address", () => {
    expect(guestIsLeftOnNothing(onThread)).toBe(true);
  });

  it("is left to upstream while another thread remains, and before the server has listed any", () => {
    expect(guestIsLeftOnNothing({ ...onThread, threadCount: 1 })).toBe(false);
    expect(guestIsLeftOnNothing({ ...onThread, listed: false })).toBe(false);
  });

  it("never moves a member, or a guest who is somewhere else", () => {
    expect(guestIsLeftOnNothing({ ...onThread, isGuest: false })).toBe(false);
    expect(guestIsLeftOnNothing({ ...onThread, onThreadAddress: false })).toBe(false);
  });
});
