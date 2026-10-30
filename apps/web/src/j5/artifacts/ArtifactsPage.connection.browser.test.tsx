import { J5ActionError } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const testState = vi.hoisted(() => ({
  connected: false,
  socketPhase: "connected",
  listArtifacts: vi.fn(),
  readArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  deleteAllArtifacts: vi.fn(),
  confirm: vi.fn(),
  canDeleteAll: true,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: (() => [
    {
      id: "project:artifacts-connection",
      environmentId: "environment:artifacts-connection",
      title: "Artifacts test",
      workspaceRoot: "/workspace",
    },
    {
      id: "project:second",
      environmentId: "environment:artifacts-connection",
      title: "Second workspace",
      workspaceRoot: "/second",
    },
  ]) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "environment:artifacts-connection",
        label: "Test environment",
        connection: { phase: testState.socketPhase },
      },
    ],
  })) as never,
}));
// The delete permissions are stand-in atoms; anything else the tree reads resolves normally.
vi.mock(import("@effect/atom-react"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useAtomValue: ((atom: never) =>
      atom === ("delete-one" as never)
        ? true
        : atom === ("delete-all" as never)
          ? testState.canDeleteAll
          : original.useAtomValue(atom)) as never,
  };
});
vi.mock(import("../state"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    j5Environment: {
      ...original.j5Environment,
      deleteArtifact: { permissionAtom: () => "delete-one" },
      deleteAllArtifacts: { permissionAtom: () => "delete-all" },
    } as never,
  };
});
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePreparedConnection: (() => (testState.connected ? Option.some({}) : Option.none())) as never,
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: undefined, error: null })) as never,
}));
vi.mock(import("./artifactChanges"), async (importOriginal) => ({
  ...(await importOriginal()),
  artifactEnvironment: { changes: () => Symbol("artifact-changes") } as never,
}));
vi.mock(import("./artifactClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  listArtifacts: testState.listArtifacts,
  readArtifact: testState.readArtifact,
  deleteArtifact: testState.deleteArtifact,
  deleteAllArtifacts: testState.deleteAllArtifacts,
}));
vi.mock(import("../../confirmDialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  requestConfirmDialog: testState.confirm,
}));
vi.mock(import("../../components/ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));
vi.mock(import("../../components/DiffFilePathCopyButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  DiffFilePathCopyButton: (() => null) as never,
}));

import { act, render } from "../../../test/render";
import { ArtifactsPage } from "./ArtifactsPage";

const renderPage = (props: Partial<Parameters<typeof ArtifactsPage>[0]> = {}) => (
  <ArtifactsPage
    embedded
    initialEnvironmentId="environment:artifacts-connection"
    initialProjectId="project:artifacts-connection"
    {...props}
  />
);

function setup() {
  testState.connected = false;
  testState.socketPhase = "connected";
  testState.listArtifacts.mockReset().mockResolvedValue([]);
  testState.readArtifact.mockReset();
  testState.deleteArtifact.mockReset();
  testState.deleteAllArtifacts.mockReset().mockResolvedValue(undefined);
  testState.confirm.mockReset().mockResolvedValue(true);
  testState.canDeleteAll = true;
}

const planEntry = { path: "plan.md", byteLength: 10, modifiedAt: null };
const bulkDelete = () => page.getByRole("button", { name: "Delete all artifacts permanently" });
const deleteOne = () => page.getByRole("button", { name: "Delete artifact permanently" });
// Dispatched inside act so the confirmation and deletion promises settle before assertions.
const click = (locator: ReturnType<typeof page.getByRole>) =>
  act(() => (locator.element() as HTMLElement).click());
const switchProject = () => click(page.getByRole("button", { name: /Second workspace/ }));

// A connected page listing one plan, whose preview reads "Plan contents".
function setupConnectedPlan() {
  setup();
  testState.connected = true;
  testState.listArtifacts.mockResolvedValue([planEntry]);
  testState.readArtifact.mockResolvedValue({
    ...planEntry,
    encoding: "utf8",
    content: "Plan contents",
  });
}

describe("ArtifactsPage delete all", () => {
  it.each([false, true])(
    "deletes only the selected project and clears its preview (embedded=%s)",
    async (embedded) => {
      setupConnectedPlan();
      testState.deleteAllArtifacts.mockImplementation(async () => {
        testState.listArtifacts.mockResolvedValue([]);
      });
      await using _screen = await render(renderPage({ embedded, initialPath: "plan.md" }));
      await expect.element(page.getByText("Plan contents")).toBeVisible();
      await expect.element(bulkDelete()).toBeEnabled();
      await click(bulkDelete());
      expect(testState.confirm).toHaveBeenCalledWith(
        expect.stringContaining("all artifacts in “Artifacts test”"),
        { variant: "destructive" },
        { confirmLabel: "Delete all permanently" },
      );
      expect(testState.deleteAllArtifacts).toHaveBeenCalledExactlyOnceWith({
        environmentId: "environment:artifacts-connection",
        projectId: "project:artifacts-connection",
      });
      expect(testState.deleteArtifact).not.toHaveBeenCalled();
      await expect.element(page.getByText("Plan contents")).not.toBeInTheDocument();
      await expect.element(bulkDelete()).toBeDisabled();
    },
  );

  it("keeps files when confirmation is cancelled", async () => {
    setupConnectedPlan();
    testState.confirm.mockResolvedValue(false);
    await using _screen = await render(renderPage());
    await expect.element(bulkDelete()).toBeEnabled();
    await click(bulkDelete());
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
    await expect.element(bulkDelete()).toBeEnabled();
  });

  it.each([false, true])(
    "allows confirmed cleanup after the typed browsing limit error (embedded=%s)",
    async (embedded) => {
      setupConnectedPlan();
      testState.listArtifacts.mockRejectedValue(
        new J5ActionError({
          code: "ArtifactListTooLargeError",
          message: "The artifacts directory is too large to browse (maximum 500 files).",
        }),
      );
      testState.deleteAllArtifacts.mockImplementation(async () => {
        testState.listArtifacts.mockResolvedValue([]);
      });
      await using _screen = await render(renderPage({ embedded }));
      await expect.element(bulkDelete()).toBeEnabled();
      testState.confirm.mockResolvedValueOnce(false);
      await click(bulkDelete());
      expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
      await click(bulkDelete());
      expect(testState.deleteAllArtifacts).toHaveBeenCalledExactlyOnceWith({
        environmentId: "environment:artifacts-connection",
        projectId: "project:artifacts-connection",
      });
      await expect.element(bulkDelete()).toBeDisabled();
    },
  );

  it.each(["ArtifactWorkspaceError", "EnvironmentAuthorizationError"])(
    "keeps bulk cleanup disabled for a %s listing failure",
    async (code) => {
      setupConnectedPlan();
      testState.listArtifacts.mockRejectedValue(
        new J5ActionError({ code, message: "Artifacts could not be loaded." }),
      );
      await using _screen = await render(renderPage());
      await expect.element(page.getByText("Artifacts could not be loaded.")).toBeVisible();
      await expect.element(bulkDelete()).toBeDisabled();
    },
  );

  it("does not carry the size-limit cleanup permission to another project's failure", async () => {
    setupConnectedPlan();
    testState.listArtifacts.mockImplementation(({ projectId }) =>
      Promise.reject(
        new J5ActionError({
          code:
            projectId === "project:artifacts-connection"
              ? "ArtifactListTooLargeError"
              : "ArtifactWorkspaceError",
          message: "Artifacts could not be loaded.",
        }),
      ),
    );
    await using _screen = await render(<ArtifactsPage />);
    await expect.element(bulkDelete()).toBeEnabled();
    await switchProject();
    await expect.element(bulkDelete()).toBeDisabled();
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
  });

  it("does not delete a different project when selection changes during confirmation", async () => {
    setupConnectedPlan();
    let confirm!: (accepted: boolean) => void;
    testState.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    await using _screen = await render(<ArtifactsPage />);
    await expect.element(bulkDelete()).toBeEnabled();
    await click(bulkDelete());
    await switchProject();
    await act(() => confirm(true));
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
  });

  it("disables deletion while disconnected or without permission", async () => {
    setupConnectedPlan();
    testState.connected = false;
    await using screen = await render(renderPage());
    await expect.element(bulkDelete()).toBeDisabled();
    testState.connected = true;
    testState.canDeleteAll = false;
    await screen.rerender(renderPage());
    await expect.element(page.getByRole("button", { name: "plan.md" })).toBeVisible();
    await expect.element(bulkDelete()).toBeDisabled();
    expect(testState.confirm).not.toHaveBeenCalled();
  });

  it("disables both delete actions until completion, then refreshes after a partial failure", async () => {
    setupConnectedPlan();
    let reject!: (error: Error) => void;
    testState.deleteAllArtifacts.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await using _screen = await render(renderPage({ initialPath: "plan.md" }));
    await expect.element(page.getByText("Plan contents")).toBeVisible();
    await expect.element(deleteOne()).toBeEnabled();
    const readsBefore = testState.listArtifacts.mock.calls.length;
    await click(bulkDelete());
    await expect.element(bulkDelete()).toBeDisabled();
    await expect.element(deleteOne()).toBeDisabled();
    testState.listArtifacts.mockResolvedValue([]);
    await act(() => reject(new Error("File could not be deleted")));
    expect(testState.listArtifacts.mock.calls.length).toBeGreaterThan(readsBefore);
    await expect
      .element(page.getByText("Some artifacts may already have been deleted.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("Plan contents")).not.toBeInTheDocument();
  });
});

describe("ArtifactsPage environment connection", () => {
  it("waits for the prepared connection and the socket before listing artifacts", async () => {
    setup();
    testState.socketPhase = "connecting";
    await using screen = await render(renderPage());
    expect(testState.listArtifacts).not.toHaveBeenCalled();

    testState.connected = true;
    await screen.rerender(renderPage());
    expect(testState.listArtifacts).not.toHaveBeenCalled();

    testState.socketPhase = "connected";
    await screen.rerender(renderPage());
    expect(testState.listArtifacts).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment:artifacts-connection",
      projectId: "project:artifacts-connection",
    });
  });
});

it.each(["one", "all"])(
  "drops a failed deletion (%s) after switching projects and keeps the new preview",
  async (mode) => {
    setup();
    testState.connected = true;
    testState.listArtifacts.mockResolvedValue([planEntry]);
    testState.readArtifact.mockImplementation(({ projectId }) =>
      Promise.resolve({ ...planEntry, encoding: "utf8", content: projectId }),
    );
    let rejectDeletion!: (error: Error) => void;
    const deletion = mode === "one" ? testState.deleteArtifact : testState.deleteAllArtifacts;
    deletion.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectDeletion = reject;
        }),
    );
    await using _screen = await render(renderPage({ embedded: false, initialPath: "plan.md" }));
    const action = mode === "one" ? deleteOne() : bulkDelete();
    await expect.element(action).toBeEnabled();
    await click(action);
    expect(deletion).toHaveBeenCalledOnce();
    await switchProject();
    await click(page.getByRole("button", { name: "plan.md" }));
    await act(() => rejectDeletion(new Error("Old project deletion failed")));
    await expect.element(page.getByText("project:second")).toBeVisible();
    await expect.element(page.getByText("Old project deletion failed")).not.toBeInTheDocument();
    expect(testState.readArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "project:second", path: "plan.md" }),
    );
  },
);
