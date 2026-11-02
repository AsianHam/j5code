import { describe, expect, it, vi } from "vite-plus/test";

const copied = vi.hoisted(() => [] as string[]);
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string, params: object) => ({ type: "PUSH", name, params }) },
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({
  copyTextWithHaptic: (value: string) => copied.push(value),
}));

import {
  artifactLinkContextMenu,
  artifactPathForMarkdownLink,
  onArtifactLinkMenuAction,
  openArtifactLink,
} from "./artifactLinks";

describe("artifact links in chat", () => {
  const root = "/work/repo";

  it.each([
    ["artifacts/plan.md", "plan.md"],
    ["./artifacts/handoffs/builder.md", "handoffs/builder.md"],
    ["/work/repo/artifacts/diagrams/flow.html", "diagrams/flow.html"],
  ])("opens %s as the artifact %s", (href, path) => {
    expect(artifactPathForMarkdownLink(href, root)).toBe(path);
  });

  it.each(["src/artifacts/plan.md", "README.md", "https://example.com/artifacts/plan.md"])(
    "leaves %s to the workspace or browser",
    (href) => {
      expect(artifactPathForMarkdownLink(href, root)).toBeNull();
    },
  );
});

describe("artifact link actions", () => {
  const pushed: object[] = [];
  const context = {
    navigation: { dispatch: (action: object) => pushed.push(action) },
    environmentId: "env",
    threadId: "thread",
    workspaceRoot: "/work/repo",
  };

  it("pushes the viewer, so a link from one artifact to another can go back", () => {
    expect(openArtifactLink("artifacts/handoffs/builder.md", context)).toBe(true);
    expect(pushed.at(-1)).toEqual({
      type: "PUSH",
      name: "ThreadArtifact",
      params: { environmentId: "env", threadId: "thread", path: ["handoffs", "builder.md"] },
    });
  });

  it("offers no workspace-file actions on an artifact link", () => {
    expect(artifactLinkContextMenu("artifacts/plan.md", "/work/repo")).toEqual({
      title: "artifacts/plan.md",
      actions: [
        { id: "open-artifact", title: "Open artifact" },
        { id: "copy-artifact-path", title: "Copy path" },
      ],
    });
    expect(artifactLinkContextMenu("README.md", "/work/repo")).toBeUndefined();
  });

  it("copies the logical path and leaves other links to the workspace menu", () => {
    expect(onArtifactLinkMenuAction("artifacts/plan.md", "copy-artifact-path", context)).toBe(true);
    expect(copied).toEqual(["artifacts/plan.md"]);
    expect(onArtifactLinkMenuAction("README.md", "save", context)).toBe(false);
  });
});
