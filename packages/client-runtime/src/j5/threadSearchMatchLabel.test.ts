import { describe, expect, it } from "vite-plus/test";

import { threadSearchMatchLabel } from "./sharedConversation.ts";

describe("threadSearchMatchLabel", () => {
  it("reads your own message as yours", () => {
    expect(threadSearchMatchLabel({ source: "user", author: { _tag: "you" } })).toBe("You");
  });

  it("names another person's message by the name they wrote under", () => {
    expect(
      threadSearchMatchLabel({ source: "user", author: { _tag: "person", name: "Priya" } }),
    ).toBe("Priya");
    expect(threadSearchMatchLabel({ source: "user", author: { _tag: "person", name: null } })).toBe(
      "Someone",
    );
  });

  it("keeps upstream's labels when the server names no author", () => {
    expect(threadSearchMatchLabel({ source: "assistant" })).toBe("Agent");
    expect(threadSearchMatchLabel({ source: "user" })).toBe("You");
  });
});
