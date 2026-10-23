import { act } from "react";
import { J5ActionError } from "@t3tools/contracts/j5";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("../../state/entities", () => ({
  useProjects: () => [
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
  ],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment:artifacts-connection",
        label: "Test environment",
        connection: { phase: testState.socketPhase },
      },
    ],
  }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => atom !== "delete-all" || testState.canDeleteAll,
}));
vi.mock("../state", () => ({
  j5Environment: {
    deleteArtifact: { permissionAtom: () => null },
    deleteAllArtifacts: { permissionAtom: () => "delete-all" },
  },
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () =>
    testState.connected ? { _tag: "Some", value: {} } : { _tag: "None" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("../../hooks/useResizableWidth", () => ({
  useResizableWidth: () => ({ width: 176, handlers: {} }),
}));
vi.mock("./artifactChanges", () => ({
  artifactEnvironment: { changes: () => Symbol("artifact-changes") },
}));
vi.mock("./artifactClient", () => ({
  listArtifacts: testState.listArtifacts,
  readArtifact: testState.readArtifact,
  deleteArtifact: testState.deleteArtifact,
  deleteAllArtifacts: testState.deleteAllArtifacts,
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: testState.confirm }));
vi.mock("../../components/ChatMarkdown", () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("../../components/DiffFilePathCopyButton", () => ({
  DiffFilePathCopyButton: () => null,
}));
vi.mock("../../components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("../../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: React.PropsWithChildren) => <main>{children}</main>,
}));
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipPopup: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children, render }: React.PropsWithChildren<{ render?: React.ReactNode }>) => (
    <>{render ?? children}</>
  ),
}));
vi.mock("../../components/WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: ({ children }: React.PropsWithChildren) => <>{children}</>,
  WorkspaceBreadcrumbItem: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../workspaceTitlebar", () => ({ COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS: "" }));

import { ArtifactsPage } from "./ArtifactsPage";

const renderPage = () => (
  <ArtifactsPage
    embedded
    initialEnvironmentId="environment:artifacts-connection"
    initialProjectId="project:artifacts-connection"
  />
);

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.connected = false;
  testState.socketPhase = "connected";
  testState.listArtifacts.mockReset().mockResolvedValue([]);
  testState.readArtifact.mockReset();
  testState.deleteArtifact.mockReset();
  testState.deleteAllArtifacts.mockReset().mockResolvedValue(undefined);
  testState.confirm.mockReset().mockResolvedValue(true);
  testState.canDeleteAll = true;
});

const planEntry = { path: "plan.md", byteLength: 10, modifiedAt: null };
const bulkDeleteButton = () =>
  renderer!.root.findByProps({ "aria-label": "Delete all artifacts permanently" });
const switchProject = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) =>
      button.findAllByType("span").some((span) => span.children.includes("Second workspace")),
    )!
    .props.onClick();

describe("ArtifactsPage delete all", () => {
  beforeEach(() => {
    testState.connected = true;
    testState.listArtifacts.mockResolvedValue([planEntry]);
    testState.readArtifact.mockResolvedValue({
      ...planEntry,
      encoding: "utf8",
      content: "Plan contents",
    });
  });

  it.each([false, true])(
    "deletes only the selected project and clears its preview (embedded=%s)",
    async (embedded) => {
      testState.deleteAllArtifacts.mockImplementation(async () => {
        testState.listArtifacts.mockResolvedValue([]);
      });
      await act(async () => {
        renderer = create(
          <ArtifactsPage
            embedded={embedded}
            initialEnvironmentId="environment:artifacts-connection"
            initialProjectId="project:artifacts-connection"
          />,
        );
      });
      expect(bulkDeleteButton().props.disabled).toBe(false);
      await act(async () => bulkDeleteButton().props.onClick());
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
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Plan contents");
      expect(bulkDeleteButton().props.disabled).toBe(true);
    },
  );

  it("keeps files when confirmation is cancelled", async () => {
    testState.confirm.mockResolvedValue(false);
    await act(async () => {
      renderer = create(renderPage());
    });
    await act(async () => bulkDeleteButton().props.onClick());
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
    expect(bulkDeleteButton().props.disabled).toBe(false);
  });

  it.each([false, true])(
    "allows confirmed cleanup after the typed browsing limit error (embedded=%s)",
    async (embedded) => {
      testState.listArtifacts.mockRejectedValue(
        new J5ActionError({
          code: "ArtifactListTooLargeError",
          message: "The artifacts directory is too large to browse (maximum 500 files).",
        }),
      );
      testState.deleteAllArtifacts.mockImplementation(async () => {
        testState.listArtifacts.mockResolvedValue([]);
      });
      await act(async () => {
        renderer = create(
          <ArtifactsPage
            embedded={embedded}
            initialEnvironmentId="environment:artifacts-connection"
            initialProjectId="project:artifacts-connection"
          />,
        );
      });
      expect(bulkDeleteButton().props.disabled).toBe(false);
      testState.confirm.mockResolvedValueOnce(false);
      await act(async () => bulkDeleteButton().props.onClick());
      expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
      await act(async () => bulkDeleteButton().props.onClick());
      expect(testState.deleteAllArtifacts).toHaveBeenCalledExactlyOnceWith({
        environmentId: "environment:artifacts-connection",
        projectId: "project:artifacts-connection",
      });
      expect(bulkDeleteButton().props.disabled).toBe(true);
    },
  );

  it.each(["ArtifactWorkspaceError", "EnvironmentAuthorizationError"])(
    "keeps bulk cleanup disabled for a %s listing failure",
    async (code) => {
      testState.listArtifacts.mockRejectedValue(
        new J5ActionError({ code, message: "Artifacts could not be loaded." }),
      );
      await act(async () => {
        renderer = create(renderPage());
      });
      expect(bulkDeleteButton().props.disabled).toBe(true);
      await act(async () => bulkDeleteButton().props.onClick());
      expect(testState.confirm).not.toHaveBeenCalled();
      expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
    },
  );

  it("does not carry the size-limit cleanup permission to another project's failure", async () => {
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
    await act(async () => {
      renderer = create(<ArtifactsPage />);
    });
    expect(bulkDeleteButton().props.disabled).toBe(false);
    await act(async () => switchProject());
    expect(bulkDeleteButton().props.disabled).toBe(true);
    await act(async () => bulkDeleteButton().props.onClick());
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
  });

  it("does not delete a different project when selection changes during confirmation", async () => {
    let confirm!: (accepted: boolean) => void;
    testState.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    await act(async () => {
      renderer = create(<ArtifactsPage />);
    });
    await act(async () => bulkDeleteButton().props.onClick());
    await act(async () => switchProject());
    await act(async () => {
      confirm(true);
    });
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
  });

  it("disables deletion while disconnected or without permission", async () => {
    testState.connected = false;
    await act(async () => {
      renderer = create(renderPage());
    });
    expect(bulkDeleteButton().props.disabled).toBe(true);
    testState.connected = true;
    testState.canDeleteAll = false;
    await act(async () => renderer!.update(renderPage()));
    expect(bulkDeleteButton().props.disabled).toBe(true);
    await act(async () => bulkDeleteButton().props.onClick());
    expect(testState.confirm).not.toHaveBeenCalled();
    expect(testState.deleteAllArtifacts).not.toHaveBeenCalled();
  });

  it("disables both delete actions until completion, then refreshes after a partial failure", async () => {
    let reject!: (error: Error) => void;
    testState.deleteAllArtifacts.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await act(async () => {
      renderer = create(renderPage());
    });
    const readsBefore = testState.listArtifacts.mock.calls.length;
    await act(async () => bulkDeleteButton().props.onClick());
    expect(bulkDeleteButton().props.disabled).toBe(true);
    expect(
      renderer!.root.findByProps({ "aria-label": "Delete artifact permanently" }).props.disabled,
    ).toBe(true);
    testState.listArtifacts.mockResolvedValue([]);
    await act(async () => {
      reject(new Error("File could not be deleted"));
    });
    expect(testState.listArtifacts.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Some artifacts may already have been deleted.",
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Plan contents");
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ArtifactsPage environment connection", () => {
  it("waits for the prepared connection and the socket before listing artifacts", async () => {
    testState.socketPhase = "connecting";
    await act(async () => {
      renderer = create(renderPage());
    });
    expect(testState.listArtifacts).not.toHaveBeenCalled();

    testState.connected = true;
    await act(async () => {
      renderer?.update(renderPage());
    });
    expect(testState.listArtifacts).not.toHaveBeenCalled();

    testState.socketPhase = "connected";
    await act(async () => {
      renderer?.update(renderPage());
    });

    expect(testState.listArtifacts).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment:artifacts-connection",
      projectId: "project:artifacts-connection",
    });
  });
});

it.each(["one", "all"])(
  "drops a failed deletion (%s) after switching projects and keeps the new preview",
  async (mode) => {
    testState.connected = true;
    testState.listArtifacts.mockResolvedValue([
      { path: "plan.md", byteLength: 10, modifiedAt: null },
    ]);
    testState.readArtifact.mockImplementation(({ projectId }) =>
      Promise.resolve({
        path: "plan.md",
        byteLength: 10,
        encoding: "utf8",
        content: projectId,
      }),
    );
    let rejectDeletion!: (error: Error) => void;
    const deletion = mode === "one" ? testState.deleteArtifact : testState.deleteAllArtifacts;
    deletion.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectDeletion = reject;
        }),
    );
    await act(async () => {
      renderer = create(
        <ArtifactsPage
          initialProjectId="project:artifacts-connection"
          initialEnvironmentId="environment:artifacts-connection"
          initialPath="plan.md"
        />,
      );
    });
    await act(async () => {
      renderer!.root
        .findByProps({
          "aria-label":
            mode === "one" ? "Delete artifact permanently" : "Delete all artifacts permanently",
        })
        .props.onClick();
    });
    expect(deletion).toHaveBeenCalledOnce();
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) =>
          button.findAllByType("span").some((span) => span.children.includes("Second workspace")),
        )!
        .props.onClick();
    });
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((button) =>
          button.findAllByType("span").some((span) => span.children.includes("plan.md")),
        )!
        .props.onClick();
    });
    await act(async () => {
      rejectDeletion(new Error("Old project deletion failed"));
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Old project deletion failed");
    expect(testState.readArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "project:second", path: "plan.md" }),
    );
  },
);
