import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  CrewProposal,
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
} from "@t3tools/contracts/j5";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  permitted: true,
  preview: vi.fn(),
  read: vi.fn(),
  memberModels: null as ReadonlyArray<{ instanceId: string; model: string }> | null,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: ((atom: unknown) => atom) as never,
}));
vi.mock("../state", () => ({
  j5Environment: { resolveCrewProposal: { permissionAtom: () => state.permitted } },
  crewProposalsQueryAtom: () => "crew-proposals",
}));
vi.mock("../a2a/ParticipantIdentitiesClient", () => ({
  useParticipantLabels: () => new Map([["captain", "Release Captain"]]),
}));
vi.mock("../sharing/access", () => ({ useCanOperateThread: () => state.permitted }));
vi.mock("./useCrewMemberModels", () => ({ useCrewMemberModels: () => state.memberModels }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({ data: query === "crew-proposals" ? [proposal] : {} }),
}));
vi.mock("../a2a/humanInboxRefresh", () => ({ notifyHumanInboxChanged: vi.fn() }));
vi.mock("@t3tools/client-runtime/j5/agent-personas", () => ({
  presentAgentPersonaCatalog: () => [
    { personaId: "sentry", displayName: "Sentry", availability: "available" },
    { personaId: "critic", displayName: "Critic", availability: "available" },
  ],
}));
vi.mock("../agents/agentPersonaAtoms", () => ({
  agentPersonaEnvironment: { catalog: () => null, readAgentPersona: {} },
}));
vi.mock("./crewProposalsClient", () => ({
  previewCrewProposal: (...args: unknown[]) => state.preview(...args),
  useCrewProposalsRefresh: () => undefined,
  refreshCrewProposals: vi.fn(),
  resolveCrewProposal: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => providers },
}));
vi.mock("../../components/WorktreeBaseBranchPicker", () => ({
  WorktreeBaseBranchPicker: () => null,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.read }));

import { act, render } from "../../../test/render";
import { CrewProposalCard } from "./CrewProposalCard";
import { CrewRosterGate } from "./CrewRosterGate";
import { clearCrewProposalDraft } from "./crewProposalDraftStore";
import { resolveCrewProposal } from "./crewProposalsClient";
import { ThreadId } from "@t3tools/contracts";

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-27T00:00:00Z",
  slashCommands: [],
  skills: [],
  models: [
    { slug: "gpt-6", name: "GPT-6", isCustom: false, capabilities: null },
    { slug: "other-model", name: "Other model", isCustom: false, capabilities: null },
  ],
};
const providers: ReadonlyArray<ServerProvider> = [
  codexProvider,
  {
    ...codexProvider,
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "haiku", name: "Claude Haiku 5.5", isCustom: false, capabilities: null }],
  },
];
const proposal: CrewProposal = {
  id: "proposal:1",
  projectId: "project:1",
  captainParticipantId: "captain",
  captainThreadId: "captain-thread",
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  displayName: "Ship a fix",
  brief: "Implement and review the fix.",
  requestedSeats: [
    { seat: "builder", agentId: null, instructions: "Implement", reason: "Build the fix" },
    { seat: "reviewer", agentId: "sentry", reason: "Review independently" },
  ],
  approvedSeats: null,
  createdAt: "2026-10-27T00:00:00Z",
  resolvedAt: null,
};
const preview = (
  _environment: EnvironmentId,
  input: CrewProposalPreviewRequest,
): Promise<CrewProposalPreviewResponse> =>
  Promise.resolve({
    proposalId: input.proposalId,
    workspaceOptions: { cwd: "/repo", currentBranch: "main", worktrees: [] },
    approvalToken: "token:" + JSON.stringify(input.seats),
    seats: (input.seats ?? proposal.requestedSeats).map((seat) => ({
      seat: seat.seat,
      provider: "OpenAI",
      harness: "Codex",
      model: seat.modelSelection?.model ?? "GPT-6",
      reasoning: "High",
      access: seat.runtimeMode === "approval-required" ? "Supervised" : "Full access",
      runtimeMode: seat.runtimeMode ?? "full-access",
      modelSelection: seat.modelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6",
      },
      workspace: seat.workspace ?? { type: "shared" },
    })),
  });
const resolve = vi.fn();
function setup() {
  state.permitted = true;
  state.memberModels = null;
  state.preview.mockReset().mockImplementation(preview);
  state.read.mockReset().mockImplementation(({ input }: { input: { personaId: string } }) =>
    Promise.resolve({
      _tag: "Success",
      value: { definition: { instructions: `${input.personaId} default instructions` } },
    }),
  );
  resolve.mockReset();
  clearCrewProposalDraft(EnvironmentId.make("test"), proposal.id);
}
const card = (overrides: Partial<React.ComponentProps<typeof CrewProposalCard>> = {}) => (
  <ul>
    <CrewProposalCard
      proposal={proposal}
      environmentId={EnvironmentId.make("test")}
      busy={false}
      onResolve={resolve}
      {...overrides}
    />
  </ul>
);
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].findLast(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  )!;
const option = (trigger: string, text: string) => {
  const popup = document.getElementById(button(trigger).getAttribute("aria-controls")!)!;
  return [...popup.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.startsWith(text),
  )!;
};
const approve = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.startsWith("Approve "),
  )!;
async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}
async function input(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("saves modal edits atomically and preserves the Captain's reason", async () => {
  setup();
  await using screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  expect(approve().disabled).toBe(true);
  await input("Member instructions", "Implement carefully");
  expect(state.preview.mock.calls.at(-1)?.[1].seats[0].instructions).not.toBe(
    "Implement carefully",
  );
  await click(button("Save changes"));
  expect(screen.container.textContent).toContain("Edited");
  await click(approve());
  expect(resolve).toHaveBeenCalledWith(
    "approve",
    [
      expect.objectContaining({ instructions: "Implement carefully", reason: "Build the fix" }),
      proposal.requestedSeats[1],
    ],
    expect.stringContaining("token:"),
  );
});

it("Cancel discards edits without changing the approval roster", async () => {
  setup();
  await using screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await input("Member instructions", "Discard this edit");
  await click(button("Cancel"));
  expect(screen.container.textContent).not.toContain("Edited");
  await click(approve());
  expect(resolve.mock.calls[0]?.[1]).toEqual(proposal.requestedSeats);
});

it("adds only a complete member and Cancel does not add an empty row", async () => {
  setup();
  await using screen = await render(card(), { router: false });
  await click(button("Add crew member"));
  expect(button("Add member").disabled).toBe(true);
  await input("Member name", "tester");
  expect(button("Add member").disabled).toBe(true);
  await click(button("Cancel"));
  expect(approve().textContent).toBe("Approve Crew");
  await click(button("Add crew member"));
  await input("Member name", "tester");
  await input("Member instructions", "Test the filters");
  await click(button("Add member"));
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(3);
  expect(approve().textContent).toBe("Approve Crew");
  await click(button("Remove seat tester"));
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(2);
  expect(approve().textContent).toBe("Approve Crew");
});

it("populates persona name and instructions and uses the persona runtime defaults", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await click(button("Member persona"));
  await click(option("Member persona", "Sentry"));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Member name"]')?.value).toBe(
    "Sentry",
  );
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Member instructions"]')?.value,
  ).toBe("sentry default instructions");
  await click(button("Save changes"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0]).toEqual({
    seat: "sentry",
    agentId: "sentry",
    reason: "Build the fix",
  });
});

it("opening a persona member preserves its name and additional instructions without duplicating defaults", async () => {
  setup();
  await using _screen = await render(
    card({
      proposal: {
        ...proposal,
        requestedSeats: [{ ...proposal.requestedSeats[1]!, instructions: "Check auth" }],
      },
    }),
    { router: false },
  );
  await click(button("Edit seat reviewer"));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Member name"]')?.value).toBe(
    "reviewer",
  );
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Member instructions"]')?.value,
  ).toBe("sentry default instructions\n\nCheck auth");
  await click(button("Save changes"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0]).toEqual({
    ...proposal.requestedSeats[1],
    instructions: "Check auth",
  });
});

it("ignores a late persona read after switching back to a custom member", async () => {
  setup();
  let finish!: (value: unknown) => void;
  state.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await click(button("Member persona"));
  await click(option("Member persona", "Sentry"));
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Member persona"));
  await click(option("Member persona", "Custom member"));
  await input("Member name", "custom-review");
  await input("Member instructions", "Keep this custom brief");
  await act(async () =>
    finish({ _tag: "Success", value: { definition: { instructions: "Late persona text" } } }),
  );
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Member instructions"]')?.value,
  ).toBe("Keep this custom brief");
  await click(button("Save changes"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0]).toEqual(
    expect.objectContaining({ agentId: null, instructions: "Keep this custom brief" }),
  );
});

it("blocks saving a duplicate name and offers recovery after a persona read fails", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await input("Member name", "reviewer");
  expect(button("Save changes").disabled).toBe(true);
  expect(document.body.textContent).toContain("already exists");
  state.read.mockRejectedValueOnce(new Error("Persona unavailable"));
  await click(button("Member persona"));
  await click(option("Member persona", "Sentry"));
  expect(document.body.textContent).toContain("Persona unavailable");
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Retry persona"));
  expect(button("Save changes").disabled).toBe(false);
});

it("keeps edits and approval disabled without permission", async () => {
  setup();
  state.permitted = false;
  await using _screen = await render(card(), { router: false });
  expect(approve().disabled).toBe(true);
  expect(button("Edit seat builder").disabled).toBe(true);
  expect(button("Add crew member").disabled).toBe(true);
});

it("uses only a fresh full-roster token after saving a member", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await input("Member instructions", "Changed brief");
  let finish!: () => void;
  state.preview.mockImplementation(
    (_environment: EnvironmentId, request: CrewProposalPreviewRequest) =>
      new Promise<CrewProposalPreviewResponse>((resolve) => {
        finish = () => {
          void preview(EnvironmentId.make("test"), request).then(resolve);
        };
      }),
  );
  await click(button("Save changes"));
  expect(approve().disabled).toBe(true);
  await act(async () => finish());
  expect(approve().disabled).toBe(false);
  await click(approve());
  const [decision, seats, token] = resolve.mock.calls[0]!;
  expect(decision).toBe("approve");
  expect(token).toBe("token:" + JSON.stringify(seats));
});

it("keeps a portalled picker inside the modal and saves its chosen model", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await click(button("builder model"));
  await click(option("builder model", "Other model"));
  expect(button("Save changes")).toBeDefined();
  await click(button("Save changes"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0].modelSelection.model).toBe("other-model");
});

it("allows workspace repair in the modal when the full-roster preview fails", async () => {
  setup();
  state.preview.mockImplementation(
    (environment: EnvironmentId, request: CrewProposalPreviewRequest) => {
      if (request.seats?.some((seat) => seat.workspace?.type === "existing_worktree"))
        return Promise.reject(new Error("Worktree no longer exists"));
      return preview(environment, request);
    },
  );
  await using _screen = await render(
    card({
      proposal: {
        ...proposal,
        requestedSeats: [
          {
            ...proposal.requestedSeats[0]!,
            workspace: { type: "existing_worktree", worktreePath: "/gone" },
          },
          proposal.requestedSeats[1]!,
        ],
      },
    }),
    { router: false },
  );
  expect(approve().disabled).toBe(true);
  await click(button("Edit seat builder"));
  await click(button("builder workspace"));
  await click(option("builder workspace", "Captain's checkout"));
  await click(button("Save changes"));
  expect(approve().disabled).toBe(false);
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0].workspace).toEqual({ type: "shared" });
});

it("Escape discards modal edits and returns focus to the member's edit control", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await input("Member instructions", "Discard on escape");
  const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Member instructions"]')!;
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button("Edit seat builder"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1]).toEqual(proposal.requestedSeats);
});

it("starts as a compact strip and keeps member edits when collapsed and reopened", async () => {
  setup();
  await using screen = await render(
    <CrewRosterGate
      environmentId={EnvironmentId.make("collapse-test")}
      threadId={ThreadId.make("captain-thread")}
    />,
    { router: false },
  );
  const region = () =>
    screen.container.querySelector<HTMLElement>('[aria-label="Crew proposal roster"]')!;
  expect(button("Expand Crew proposal").getAttribute("aria-expanded")).toBe("false");
  expect(button("Expand Crew proposal").textContent).toContain("2 members");
  expect(region().hidden).toBe(true);
  expect(button("Expand Crew proposal").getAttribute("aria-controls")).toBe(region().id);
  await click(button("Expand Crew proposal"));
  expect(region().hidden).toBe(false);
  await click(button("Edit seat builder"));
  await input("Member instructions", "Keep this draft when folded");
  await click(button("Save changes"));
  await click(button("Collapse Crew proposal"));
  expect(region().hidden).toBe(true);
  await click(button("Expand Crew proposal"));
  await click(button("Edit seat builder"));
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Member instructions"]')?.value,
  ).toBe("Keep this draft when folded");
});

it("remembers disclosure for each environment and thread when the composer remounts", async () => {
  setup();
  const gate = (environment: string) => (
    <CrewRosterGate
      key={environment}
      environmentId={EnvironmentId.make(environment)}
      threadId={ThreadId.make("captain-thread")}
    />
  );
  await using screen = await render(gate("remember-test"), { router: false });
  await click(button("Expand Crew proposal"));
  await screen.rerender(null);
  await screen.rerender(gate("remember-test"));
  expect(button("Collapse Crew proposal").getAttribute("aria-expanded")).toBe("true");
  await screen.rerender(gate("different-environment"));
  expect(button("Expand Crew proposal").getAttribute("aria-expanded")).toBe("false");
  await screen.rerender(gate("remember-test"));
  await click(button("Collapse Crew proposal"));
  await screen.rerender(null);
  await screen.rerender(gate("remember-test"));
  expect(button("Expand Crew proposal").getAttribute("aria-expanded")).toBe("false");
});

it("switches provider with its model defaults and keeps the model menu scoped to that provider", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await click(button("builder provider"));
  await click(option("builder provider", "Claude"));
  expect(button("builder model").textContent).toContain("Haiku 5.5");
  await click(button("builder model"));
  expect(option("builder model", "Other model")).toBeUndefined();
  await click(option("builder model", "Haiku 5.5"));
  await click(button("Save changes"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0].modelSelection).toEqual(
    expect.objectContaining({
      instanceId: "claude",
      model: "haiku",
    }),
  );
});

it("restores saved roster edits when the card returns, for that proposal only", async () => {
  setup();
  const environmentId = EnvironmentId.make("draft-restore");
  await using screen = await render(card({ environmentId }), { router: false });
  await click(button("Edit seat builder"));
  await input("Member instructions", "Edited before the composer asked a question");
  await click(button("Save changes"));
  await click(button("Remove seat reviewer"));
  await screen.rerender(null);

  await screen.rerender(card({ environmentId }));
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(1);
  await click(approve());
  expect(resolve.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining({ instructions: "Edited before the composer asked a question" }),
  ]);

  await screen.rerender(null);
  await screen.rerender(card({ environmentId, proposal: { ...proposal, id: "proposal:2" } }));
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(2);
  await screen.rerender(null);
  await screen.rerender(card({ environmentId: EnvironmentId.make("other-draft-environment") }));
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(2);
});

it("a new member added after a restore does not reuse an earlier added row", async () => {
  setup();
  const environmentId = EnvironmentId.make("draft-added-rows");
  const addMember = async (name: string) => {
    await click(button("Add crew member"));
    await input("Member name", name);
    await input("Member instructions", `${name} instructions`);
    await click(button("Add member"));
  };
  await using screen = await render(card({ environmentId }), { router: false });
  await addMember("first");
  await screen.rerender(null);
  await screen.rerender(card({ environmentId }));
  await addMember("second");
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(4);
});

it("drops a proposal's saved edits once it is approved or declined", async () => {
  setup();
  const environmentId = EnvironmentId.make("draft-resolved");
  const gate = (
    <CrewRosterGate environmentId={environmentId} threadId={ThreadId.make("captain-thread")} />
  );
  await using screen = await render(gate, { router: false });
  await click(button("Expand Crew proposal"));
  await click(button("Remove seat reviewer"));
  await screen.rerender(null);
  await screen.rerender(gate);
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(1);

  await click(approve());
  expect(resolveCrewProposal).toHaveBeenCalledTimes(1);
  await screen.rerender(null);
  await screen.rerender(gate);
  expect(screen.container.querySelectorAll('[data-testid^="crew-member-"]')).toHaveLength(2);
});

const instructionsBox = () =>
  document.querySelector<HTMLTextAreaElement>('[aria-label="Member instructions"]')!.value;

it("an edited persona text replaces the persona's and returns when the member is reopened", async () => {
  setup();
  const environmentId = EnvironmentId.make("persona-replace");
  await using screen = await render(card({ environmentId }), { router: false });
  await click(button("Edit seat reviewer"));
  expect(instructionsBox()).toBe("sentry default instructions");
  await input("Member instructions", "Only review the auth code.");
  await click(button("Save changes"));
  expect(screen.container.textContent).toContain("Edited");
  await screen.rerender(null);

  await screen.rerender(card({ environmentId }));
  await click(button("Edit seat reviewer"));
  expect(instructionsBox()).toBe("Only review the auth code.");
  await click(button("Cancel"));
  await click(approve());
  const seat = resolve.mock.calls[0]?.[1][1];
  expect(seat).toEqual({
    ...proposal.requestedSeats[1],
    personaInstructions: "Only review the auth code.",
  });
  expect(seat).not.toHaveProperty("instructions");
});

it("a cleared persona text blocks Save until it is reset", async () => {
  setup();
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat reviewer"));
  await input("Member instructions", "");
  expect(document.body.textContent).toContain("Member instructions can't be empty");
  expect(button("Save changes")?.disabled).toBe(true);
  await click(button("Reset to persona text"));
  expect(document.body.textContent).not.toContain("Member instructions can't be empty");
  await click(button("Save changes"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][1]).toEqual(proposal.requestedSeats[1]);
});

it("Reset to persona text restores the persona's own and sends no replacement", async () => {
  setup();
  await using screen = await render(card(), { router: false });
  await click(button("Edit seat reviewer"));
  expect(button("Reset to persona text")).toBeUndefined();
  await input("Member instructions", "Something else entirely.");
  await click(button("Reset to persona text"));
  expect(instructionsBox()).toBe("sentry default instructions");
  expect(button("Reset to persona text")).toBeUndefined();
  await click(button("Save changes"));
  expect(screen.container.textContent).not.toContain("Edited");
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][1]).toEqual(proposal.requestedSeats[1]);
});

it("offers a custom member only the models its project's list allows", async () => {
  setup();
  state.memberModels = [{ instanceId: "codex", model: "gpt-6" }];
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat builder"));
  await click(button("builder model"));
  expect(option("builder model", "GPT-6")).toBeDefined();
  expect(option("builder model", "Other model")).toBeUndefined();
  await click(option("builder model", "GPT-6"));
  // No model of the other provider is on the list, so it is not offered at all.
  await click(button("builder provider"));
  expect(option("builder provider", "Codex")).toBeDefined();
  expect(option("builder provider", "Claude")).toBeUndefined();
});

it("leaves a persona member's pickers whole, since it runs on its own model", async () => {
  setup();
  state.memberModels = [{ instanceId: "codex", model: "gpt-6" }];
  await using _screen = await render(card(), { router: false });
  await click(button("Edit seat reviewer"));
  await click(button("reviewer model"));
  expect(option("reviewer model", "Other model")).toBeDefined();
});
