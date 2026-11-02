import { describe, expect, it } from "vite-plus/test";

import {
  artifactPathFromWorkspaceRelativePath,
  artifactPreviewKind,
  artifactPreviewRevision,
} from "./artifacts.ts";

describe("artifactPathFromWorkspaceRelativePath", () => {
  it.each([
    ["artifacts/plan.md", "plan.md"],
    ["./artifacts/diagrams/system.html", "diagrams/system.html"],
    [String.raw`artifacts\notes\decisions.md`, "notes/decisions.md"],
  ])("recognizes artifact paths: %s", (workspacePath, artifactPath) => {
    expect(artifactPathFromWorkspaceRelativePath(workspacePath)).toBe(artifactPath);
  });

  it.each([null, "artifacts", "src/artifacts/plan.md", "artifacts-other/plan.md"])(
    "rejects non-artifact paths: %s",
    (workspacePath) => {
      expect(artifactPathFromWorkspaceRelativePath(workspacePath)).toBeNull();
    },
  );
});

describe("artifact preview revision", () => {
  const plan = { modifiedAt: "2026-09-16T10:00:00.000Z", byteLength: 1200 };

  it("stays put when the list refreshes with the selected file unchanged", () => {
    expect(artifactPreviewRevision(plan, 0)).toBe(artifactPreviewRevision({ ...plan }, 0));
  });

  it("moves when the selected file's own size or time changes", () => {
    expect(artifactPreviewRevision({ ...plan, byteLength: 1201 }, 0)).not.toBe(
      artifactPreviewRevision(plan, 0),
    );
    expect(
      artifactPreviewRevision({ ...plan, modifiedAt: "2026-09-16T10:00:01.000Z" }, 0),
    ).not.toBe(artifactPreviewRevision(plan, 0));
  });

  it("moves on a manual refresh even when the entry cannot show a change", () => {
    const silent = { modifiedAt: null, byteLength: 1200 };
    expect(artifactPreviewRevision(silent, 0)).toBe(artifactPreviewRevision(silent, 0));
    expect(artifactPreviewRevision(silent, 1)).not.toBe(artifactPreviewRevision(silent, 0));
  });
});

describe("artifact preview kind", () => {
  it.each([
    ["plan.md", "utf8", "markdown"],
    ["diagrams/flow.HTML", "utf8", "html"],
    ["notes.txt", "utf8", "text"],
    ["Dockerfile", "utf8", "text"],
    ["shot.png", "base64", "image"],
    ["flow.svg", "utf8", "image"],
    ["archive.zip", "base64", "binary"],
    ["plan.md", "base64", "binary"],
  ] as const)("%s (%s) previews as %s", (path, encoding, kind) => {
    expect(artifactPreviewKind({ path, encoding })).toBe(kind);
  });
});
