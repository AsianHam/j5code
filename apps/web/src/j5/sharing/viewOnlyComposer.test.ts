import { describe, expect, it } from "vite-plus/test";

import { viewOnlyComposerProps } from "./viewOnlyComposer.logic";

describe("the composer's text for someone who cannot send", () => {
  it("tells a guest with View that they can read and not send", () => {
    expect(viewOnlyComposerProps({ isGuest: true, canOperateThread: false })).toEqual({
      placeholder: "You can read this thread, but not send anything to it.",
    });
  });

  it("leaves upstream's text for a member without Operate tasks", () => {
    expect(viewOnlyComposerProps({ isGuest: false, canOperateThread: false })).toEqual({});
  });

  it("leaves upstream's text for a guest who can write to the thread", () => {
    expect(viewOnlyComposerProps({ isGuest: true, canOperateThread: true })).toEqual({});
  });
});
