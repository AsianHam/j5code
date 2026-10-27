import { buildNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import { readPromptLinkPage, serverPromptLinkUrl } from "./promptLink";

describe("readPromptLinkPage", () => {
  it("reads a copied link back to its prompt, details and app link", () => {
    const link = buildNewThreadLink({
      prompt: "Fix the build",
      repository: { owner: "Jacksondr5", name: "j5code" },
      provider: "codex",
      model: "gpt-6",
    });
    const page = readPromptLinkPage(link);
    expect(page.ok && page.value.prompt).toEqual({ text: "Fix the build", hiddenCharacters: 0 });
    expect(page.ok && page.value.details).toEqual([
      "Repository Jacksondr5/j5code",
      "Model codex gpt-6",
    ]);
    expect(page.ok && page.value.deepLink).toBe(`j5code://new${new URL(link).search}`);
  });

  it("strips hidden characters and counts them", () => {
    const page = readPromptLinkPage(
      `https://j5.codes/new/?prompt=${encodeURIComponent("Fix\u200B it\u{E0041}")}`,
    );
    expect(page.ok && page.value.prompt).toEqual({ text: "Fix it", hiddenCharacters: 2 });
  });

  it("reads thread and pull request links", () => {
    const thread = readPromptLinkPage("https://j5.codes/env-1/thread-1?prompt=go");
    expect(thread.ok && thread.value.deepLink).toBe("j5code://threads/env-1/thread-1?prompt=go");
    const pr = readPromptLinkPage("https://j5.codes/new?pr=owner/name/12");
    expect(pr.ok && pr.value).toMatchObject({
      prompt: null,
      details: ["Pull request owner/name#12"],
    });
  });

  it("refuses a link with no prompt, or only hidden characters", () => {
    expect(readPromptLinkPage("https://j5.codes/new")).toEqual({
      ok: false,
      error: "This link has no prompt.",
    });
    expect(readPromptLinkPage("https://j5.codes/new?prompt=%E2%80%8B").ok).toBe(false);
  });
});

describe("serverPromptLinkUrl", () => {
  it("opens the same path on the server's origin", () => {
    expect(serverPromptLinkUrl("https://box.tail1.ts.net/settings", "/new?prompt=hi")).toBe(
      "https://box.tail1.ts.net/new?prompt=hi",
    );
  });

  it("assumes http for this machine and plain addresses, https for names", () => {
    expect(serverPromptLinkUrl(" localhost:3773 ", "/new?prompt=hi")).toBe(
      "http://localhost:3773/new?prompt=hi",
    );
    expect(serverPromptLinkUrl("192.168.1.20:3773", "/new")).toBe("http://192.168.1.20:3773/new");
    expect(serverPromptLinkUrl("j5.example.com", "/new")).toBe("https://j5.example.com/new");
  });

  it("refuses an empty or non-web address", () => {
    expect(serverPromptLinkUrl("  ", "/new")).toBeNull();
    expect(serverPromptLinkUrl("javascript://alert(1)", "/new")).toBeNull();
    expect(serverPromptLinkUrl("http://", "/new")).toBeNull();
  });
});
