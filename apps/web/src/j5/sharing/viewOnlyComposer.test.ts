import { describe, expect, it } from "vite-plus/test";

import { viewOnlyComposerProps } from "./viewOnlyComposer.logic";

describe("the composer's text for someone who cannot send", () => {
  it("tells a Viewer of the thread that they can read and not send", () => {
    expect(viewOnlyComposerProps({ personNotOwner: true, canOperateThread: false })).toEqual({
      placeholder: "You can read this thread, but not send anything to it.",
    });
  });

  it("leaves upstream's text for an Owner whose device cannot operate", () => {
    expect(viewOnlyComposerProps({ personNotOwner: false, canOperateThread: false })).toEqual({});
  });

  it("leaves upstream's text for a Collaborator, who writes", () => {
    expect(viewOnlyComposerProps({ personNotOwner: true, canOperateThread: true })).toEqual({});
  });
});
