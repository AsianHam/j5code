import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import "../../index.css";

import { filesystemEnvironment } from "../../state/filesystem";
import { useRightPanelStore } from "../../rightPanelStore";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// A standard client session, so environment-owned file links can open.
vi.mock(import("../../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));

import ChatMarkdown from "../../components/ChatMarkdown";

// FORK.md case 33: a chat link to `artifacts/…` is an artifact, not a workspace file.
describe("ChatMarkdown artifact references", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-artifact"),
    threadId: ThreadId.make("thread-artifact"),
  };

  it("styles artifact references and opens them in the artifact surface", async () => {
    workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
    filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
    using openArtifact = vi
      .spyOn(useRightPanelStore.getState(), "openArtifact")
      .mockImplementation(() => {});
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text="[Plan](artifacts/plan.md)" threadRef={threadRef} />,
    );
    const link = screen.container.querySelector<HTMLAnchorElement>("a[data-artifact]");
    expect(link).not.toBeNull();
    expect(link!.className).toContain("border-info/35");
    expect(link!.textContent).toContain("Artifact");

    await act(async () => link!.click());

    expect(openArtifact).toHaveBeenCalledExactlyOnceWith(threadRef, "plan.md");
    expect(openFile).not.toHaveBeenCalled();
  });
});
