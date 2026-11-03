import { describe, expect, it } from "vite-plus/test";

import { presentCrewContext } from "./crewNotices.ts";

const context = (text: string) =>
  `<j5_crew_delivery_context>\n${text}\n</j5_crew_delivery_context>`;
const system = (text: string) => ({ role: "user", createdBy: "system", text });

describe("presentCrewContext", () => {
  it("reads the introduction a member was given, without the wrapper", () => {
    const introduction = "<j5_crew_context>\nYou are reviewer.\n</j5_crew_context>";
    expect(presentCrewContext(system(context(introduction)))).toEqual({
      kind: "introduction",
      title: "Introduction",
      text: introduction,
    });
  });

  it("reads a roster change as its own card", () => {
    const change =
      "<j5_crew_roster_changed>\njoined: security: participant_id=p1 responsibility=audit\n</j5_crew_roster_changed>";
    expect(presentCrewContext(system(context(change)))).toEqual({
      kind: "roster-changed",
      title: "Roster changed",
      text: change,
    });
  });

  it("gives back the closing tag the server escaped inside the text", () => {
    const escaped = context("quoted <\\/j5_crew_delivery_context> inside");
    expect(presentCrewContext(system(escaped))?.text).toBe(
      "quoted </j5_crew_delivery_context> inside",
    );
  });

  it("leaves everything else to the ordinary row", () => {
    const text = context("You are reviewer.");
    expect(presentCrewContext({ role: "user", createdBy: "user", text })).toBeNull();
    expect(presentCrewContext({ role: "assistant", createdBy: "system", text })).toBeNull();
    expect(presentCrewContext(system(`Please read:\n${text}`))).toBeNull();
    expect(presentCrewContext(system(`${text}\n\nReview the fix.`))).toBeNull();
    expect(presentCrewContext(system(context("  ")))).toBeNull();
  });
});
