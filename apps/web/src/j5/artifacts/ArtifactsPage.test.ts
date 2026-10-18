// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the artifact view with its live-preview contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("./ArtifactsPage.tsx", import.meta.url), "utf8");
const rightPanelSource = NodeFS.readFileSync(
  new URL("../../components/chat/RightPanelSurfaceContent.tsx", import.meta.url),
  "utf8",
);

describe("artifact previews", () => {
  it("renders HTML in an isolated transparent iframe", () => {
    expect(source).toContain('sandbox=""');
    expect(source).toContain('referrerPolicy="no-referrer"');
    expect(source).toContain("srcDoc={content.content}");
    expect(source).toContain("border-0 bg-transparent");
  });

  it("renders a project-scoped artifact browser in the thread right panel", () => {
    expect(rightPanelSource).toContain('case "artifacts":');
    expect(rightPanelSource).toContain("<ArtifactsPage");
    expect(rightPanelSource).toContain("embedded");
    expect(rightPanelSource).toContain("initialPath: surface.selectedPath");
    expect(source).toContain("useState<string | null>(() => initialPath ?? null)");
    expect(source).toContain("grid-cols-[var(--artifact-file-pane-width)_minmax(0,1fr)]");
  });
});
