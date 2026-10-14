import { describe, expect, it } from "vite-plus/test";

import { approvalOptionsFor } from "./guestComposer.logic";

describe("the answers an approval offers", () => {
  const listed = [
    { decision: "accept", label: "Run it" },
    { decision: "acceptAlways", label: "Always run it" },
    { decision: "decline", label: "No" },
  ] as const;

  it("are the provider's own for a member, or upstream's default when it lists none", () => {
    expect(approvalOptionsFor(false, listed)).toBe(listed);
    expect(approvalOptionsFor(false, undefined)).toBeUndefined();
  });

  it("leave a guest only this one request to approve, decline or cancel", () => {
    expect(approvalOptionsFor(true, listed)?.map((option) => option.decision)).toEqual([
      "accept",
      "decline",
    ]);
    expect(approvalOptionsFor(true, undefined)?.map((option) => option.decision)).toEqual([
      "cancel",
      "decline",
      "accept",
    ]);
    // A provider that listed only lasting answers still leaves a guest a way to answer.
    expect(
      approvalOptionsFor(true, [{ decision: "acceptForSession", label: "For this session" }])?.map(
        (option) => option.decision,
      ),
    ).toEqual(["cancel", "decline", "accept"]);
  });
});
