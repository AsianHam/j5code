// @vitest-environment jsdom

import { ThreadId } from "@t3tools/contracts";
import { PlaybookError, type PlaybookProgress } from "@t3tools/contracts/j5";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PlaybookStages } from "./PlaybookStages";

const active: PlaybookProgress = {
  runId: "latest",
  ownerThreadId: ThreadId.make("thread"),
  definitionPath: "/test/playbooks/release.yaml",
  currentStepId: "build",
  status: "active",
  createdAt: "2026-10-17T12:00:00Z",
  updatedAt: "2026-10-17T12:01:00Z",
  title: "Release",
  description: "Prepare a release together.",
  steps: [
    { id: "plan", title: "Plan the release" },
    { id: "build", title: "Build the change" },
    { id: "review", title: "Review the change" },
  ],
  position: 2,
  total: 3,
  issue: null,
};

let container: HTMLDivElement;
let root: Root;
let viewKey = 0;
beforeEach(() => {
  viewKey += 1;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

async function render(runs: readonly PlaybookProgress[], stale = false) {
  await act(() =>
    root.render(<PlaybookStages runs={runs} stale={stale} viewKey={`env:thread-${viewKey}`} />),
  );
}
function toggle() {
  return container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
}
function stages() {
  return container.querySelector('ol[aria-label="Playbook stage list"]');
}

it("starts collapsed, follows pointer changes, and preserves disclosure when moving backward", async () => {
  await render([]);
  expect(container.textContent).toBe("");
  await render([active]);
  expect(toggle().textContent).toContain("Release");
  expect(toggle().getAttribute("aria-label")).toContain("Build the change");
  expect(stages()).toBeNull();

  await act(() => toggle().click());
  expect(stages()?.textContent).toContain("Completed: 1. Plan the release");
  expect(stages()?.textContent).toContain("Running: 2. Build the change");
  expect(stages()?.textContent).toContain("Pending: 3. Review the change");
  expect(toggle().textContent).toContain("1/3");
  expect(container.querySelector('[aria-label="Playbook stages"]')?.textContent).not.toContain(
    active.description,
  );
  expect(container.querySelector('[aria-label="Playbook stages"]')?.textContent).not.toContain(
    active.title,
  );

  await render([{ ...active, currentStepId: "plan", position: 1 }]);
  expect(stages()?.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Plan the release",
  );
  expect(stages()?.textContent).toContain("Pending: 2. Build the change");
  expect(toggle().textContent).toContain("0/3");
  await act(() => toggle().click());
  expect(stages()).toBeNull();
  await render([{ ...active, currentStepId: "review", position: 3 }]);
  expect(toggle().getAttribute("aria-label")).toContain("Step 3 of 3");
  expect(stages()).toBeNull();
});

it("keeps stale, unavailable, and terminal states visible while collapsed", async () => {
  await render([active], true);
  expect(toggle().textContent).toContain("Out of date");
  await act(() => toggle().click());
  expect(container.textContent).toContain("Showing the last received state");

  await render([
    {
      ...active,
      currentStepId: "removed",
      position: null,
      issue: new PlaybookError({
        code: "step_missing",
        message: "Current step was removed.",
        availableStepIds: ["plan", "build", "review"],
      }),
    },
  ]);
  expect(container.textContent).toContain("Current step was removed");
  expect(stages()?.querySelector('[aria-current="step"]')).toBeNull();
  await act(() => toggle().click());
  expect(toggle().textContent).toContain("Needs attention");
  expect(toggle().getAttribute("aria-label")).toContain("Step unavailable");

  await render([{ ...active, status: "completed" }]);
  expect(toggle().textContent).toContain("Completed");
  expect(toggle().textContent).toContain("3/3");
  await act(() => toggle().click());
  expect(stages()?.textContent).toContain("Completed: 2. Build the change");
  expect(stages()?.querySelector('[aria-current="step"]')).toBeNull();
  await render([{ ...active, currentStepId: "review", position: 3, status: "completed" }]);
  expect(toggle().textContent).toContain("3/3");
  expect(stages()?.textContent).toContain("Completed: 3. Review the change");
  await act(() => toggle().click());
  await render([{ ...active, status: "cancelled" }]);
  expect(toggle().textContent).toContain("Cancelled");
});

it("inspects history without confusing it with the latest run, then returns to latest", async () => {
  const previous = {
    ...active,
    runId: "previous",
    title: "Earlier release",
    status: "completed" as const,
  };
  await render([active, previous]);
  await act(() => toggle().click());
  const picker = () => container.querySelector<HTMLButtonElement>('[aria-label="Playbook run"]')!;
  await act(() => picker().click());
  const oldOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (node) => node.textContent?.includes("Earlier release"),
  )!;
  await act(() => oldOption.click());
  expect(toggle().textContent).toContain("Earlier release");
  expect(toggle().textContent).toContain("History");
  await act(() => toggle().click());
  expect(toggle().getAttribute("aria-label")).toContain("Earlier run");
  await act(() => toggle().click());
  await act(() => picker().click());
  const latestOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (node) => node.textContent?.includes("Latest:"),
  )!;
  await act(() => latestOption.click());
  expect(toggle().textContent).not.toContain("History");
  expect(toggle().textContent).toContain("Release");

  const next = { ...active, runId: "next", title: "Next release" };
  await render([next, active, previous]);
  expect(toggle().textContent).toContain("Next release");
  expect(toggle().textContent).not.toContain("History");
});

it("comes back expanded on the same run after the composer hides it for a question", async () => {
  const previous = { ...active, runId: "previous", title: "Earlier release" };
  await render([active, previous]);
  await act(() => toggle().click());
  await act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Playbook run"]')!.click(),
  );
  const oldOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (node) => node.textContent?.includes("Earlier release"),
  )!;
  await act(() => oldOption.click());

  await act(() => root.render(null));
  await render([active, previous]);
  expect(stages()).not.toBeNull();
  expect(toggle().textContent).toContain("Earlier release");
});
