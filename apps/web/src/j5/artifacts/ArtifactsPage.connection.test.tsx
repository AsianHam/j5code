import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  connected: false,
  socketPhase: "connected",
  listArtifacts: vi.fn(),
  readArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
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
// The page's only atom is the delete command's permission.
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../state", () => ({
  j5Environment: { deleteArtifact: { permissionAtom: () => null } },
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () =>
    testState.connected ? { _tag: "Some", value: {} } : { _tag: "None" },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
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
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: () => Promise.resolve(true) }));
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

it("drops a failed deletion after switching projects and keeps the new preview", async () => {
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
  testState.deleteArtifact.mockImplementation(
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
    renderer!.root.findByProps({ "aria-label": "Delete artifact permanently" }).props.onClick();
  });
  expect(testState.deleteArtifact).toHaveBeenCalledOnce();
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
});
