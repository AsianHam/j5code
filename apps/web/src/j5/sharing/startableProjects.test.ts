import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  openableFromSearch,
  readStartableProjectRef,
  startableMemberRef,
  startableProjectPicker,
} from "./startableProjects";
import { provideSharingStart } from "./startAccess";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};

const project = (environmentId: EnvironmentId, id: string, title = "shared-repo"): Project => ({
  id: ProjectId.make(id),
  environmentId,
  title,
  workspaceRoot: `/tmp/${id}`,
  repositoryIdentity: title === "shared-repo" ? repositoryIdentity : null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
});

// One repository checked out on both servers, shown as one group whose representative is local.
const groups = buildSidebarProjectSnapshots({
  projects: [project(LOCAL, "shared-local"), project(REMOTE, "shared-remote")],
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: LOCAL,
  resolveEnvironmentLabel: () => null,
});

const startsOnlyIn =
  (...ids: string[]) =>
  (_environmentId: EnvironmentId, projectId: ProjectId) =>
    ids.includes(projectId);

describe("the projects offered a new thread", () => {
  it("offers a group by a checkout that can take a thread when its usual one cannot", () => {
    const picker = startableProjectPicker({
      groups,
      preferredProjectRef: null,
      canStartIn: startsOnlyIn("shared-remote"),
    });
    expect(picker.projects.map((entry) => entry.id)).toEqual(["shared-remote"]);
    expect(picker.projects[0]?.displayName).toBe(groups[0]?.displayName);
  });

  it("keeps a click in the group from falling back to a checkout that cannot take a thread", () => {
    const picker = startableProjectPicker({
      groups,
      preferredProjectRef: { environmentId: LOCAL, projectId: ProjectId.make("shared-local") },
      canStartIn: startsOnlyIn("shared-remote"),
    });
    const group = picker.groupByTargetKey.get(`${REMOTE}:shared-remote`);
    expect(group?.memberProjectRefs).toEqual([
      { environmentId: REMOTE, projectId: "shared-remote" },
    ]);
  });

  it("leaves out a group none of whose checkouts can take a thread", () => {
    expect(
      startableProjectPicker({ groups, preferredProjectRef: null, canStartIn: startsOnlyIn() })
        .projects,
    ).toEqual([]);
  });

  it("leaves a group upstream's when every checkout can take a thread", () => {
    const picker = startableProjectPicker({
      groups,
      preferredProjectRef: { environmentId: REMOTE, projectId: ProjectId.make("shared-remote") },
      canStartIn: startsOnlyIn("shared-local", "shared-remote"),
    });
    expect(picker.projects.map((entry) => entry.id)).toEqual(["shared-remote"]);
    expect(picker.groupByTargetKey.get(`${REMOTE}:shared-remote`)).toBe(groups[0]);
  });
});

describe("a project picked from search", () => {
  const picked = { environmentId: LOCAL, id: ProjectId.make("shared-local") };

  it("starts a new thread in another checkout of its group when the picked one cannot take one", () => {
    expect(
      startableMemberRef({
        project: picked,
        group: groups[0],
        canStartIn: startsOnlyIn("shared-remote"),
      }),
    ).toEqual({ environmentId: REMOTE, projectId: "shared-remote" });
  });

  it("starts nowhere when no checkout of its group can take a thread", () => {
    expect(
      startableMemberRef({ project: picked, group: groups[0], canStartIn: startsOnlyIn() }),
    ).toBeNull();
  });

  it("can still be picked to open a thread when no checkout can take a new one", () => {
    expect(
      openableFromSearch({
        project: picked,
        group: groups[0],
        projectKeysWithThreads: new Set([`${REMOTE}:shared-remote`]),
        canStartIn: startsOnlyIn(),
      }),
    ).toBe(true);
  });

  it("cannot be picked with no thread to open and no checkout to start one in", () => {
    expect(
      openableFromSearch({
        project: picked,
        group: groups[0],
        projectKeysWithThreads: new Set(),
        canStartIn: startsOnlyIn(),
      }),
    ).toBe(false);
  });
});

describe("a plain New thread click the open project refuses", () => {
  it("goes to a checkout the person can start in", () => {
    provideSharingStart((_environmentId, projectId) => projectId === "shared-remote");
    expect(readStartableProjectRef(groups)).toEqual({
      environmentId: REMOTE,
      projectId: "shared-remote",
    });
  });

  it("goes nowhere when no checkout can take a thread", () => {
    provideSharingStart(() => false);
    expect(readStartableProjectRef(groups)).toBeNull();
  });
});
