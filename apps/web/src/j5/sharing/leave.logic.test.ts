import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SharingOwnGrant } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { grantsToLeave, leaveChoiceFor, leaveWording } from "./leave.logic";

const onThread = (threadId: string) =>
  ({ target: { kind: "thread", threadId }, level: "view" }) as SharingOwnGrant;
const onProject = (projectId: string) =>
  ({ target: { kind: "project", projectId }, level: "view" }) as SharingOwnGrant;
const thread = { threadId: "t1" as ThreadId, projectId: "p1" as ProjectId };
const titles = { thread: "Replay fixture: proposed_plan", project: "Live test repo" };

describe("what a guest leaves to stop reaching a thread", () => {
  it("is the grant on the thread itself when only the thread is shared", () => {
    const choice = leaveChoiceFor([onProject("other"), onThread("t1")], thread);
    expect(choice).toEqual({ kind: "thread", target: { kind: "thread", threadId: "t1" } });
    expect(grantsToLeave(choice)).toEqual([{ kind: "thread", threadId: "t1" }]);
    expect(leaveWording(choice, titles)).toEqual({
      title: "Leave Replay fixture: proposed_plan?",
      description: "It disappears from your list. To get it back, ask a member to share it again.",
    });
  });

  it("is the project too when the thread is shared on its own and with its project", () => {
    // Leaving the thread's own grant would leave it in the list, still covered by the project.
    const choice = leaveChoiceFor([onProject("p1"), onThread("t1")], thread);
    expect(choice.kind).toBe("thread-and-project");
    expect(grantsToLeave(choice)).toEqual([
      { kind: "project", projectId: "p1" },
      { kind: "thread", threadId: "t1" },
    ]);
    const wording = leaveWording(choice, titles);
    expect(wording.title).toBe("Leave Live test repo?");
    // It says the thread would stay, and that the whole project goes.
    expect(wording.description).toContain("stays in your list");
    expect(wording.description).toContain("every thread in it");
  });

  it("is the project's grant otherwise, and the confirmation says every thread goes", () => {
    const choice = leaveChoiceFor([onProject("p1"), onThread("t2")], thread);
    expect(choice).toEqual({ kind: "project", target: { kind: "project", projectId: "p1" } });
    const wording = leaveWording(choice, titles);
    expect(wording.title).toBe("Leave Live test repo?");
    expect(wording.description).toContain("Every thread in the project");
  });

  it("is nothing for an agent beneath a shared thread, which goes with that thread", () => {
    const choice = leaveChoiceFor([onThread("parent")], thread);
    expect(choice).toEqual({ kind: "through-another-thread" });
    expect(leaveWording(choice, titles).title).toBe(
      "Replay fixture: proposed_plan cannot be left by itself",
    );
  });
});
