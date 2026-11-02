import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ArchiveWarning } from "@t3tools/client-runtime/j5/archive-flow";
import type { PreArchiveFacts } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  facts: null as unknown,
  labels: [] as { participantId: string; displayName: string }[],
  confirms: [] as { warning: ArchiveWarning; resolve: (confirmed: boolean) => void }[],
  alerts: [] as { title: string; message: string }[],
}));

vi.mock("../../components/ui/Dialog", () => ({
  alert: (title: string, message: string) => state.alerts.push({ title, message }),
}));
vi.mock("./ArchiveWarningSheet", () => ({
  presentArchiveWarning: (warning: ArchiveWarning) =>
    new Promise<boolean>((resolve) => state.confirms.push({ warning, resolve })),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../state", () => ({
  j5Environment: {
    readPreArchiveFacts: {
      run: async () =>
        state.facts === null
          ? AsyncResult.failure(Cause.fail(new Error("offline")))
          : AsyncResult.success(state.facts),
    },
    readParticipantIdentities: {
      run: async () =>
        AsyncResult.success({
          entries: state.labels.map(({ participantId, displayName }) => ({
            participantId,
            identity: { kind: "known", displayName },
          })),
        }),
    },
  },
}));

import { confirmJ5Archive } from "./confirmArchive";

const thread = makeThreadShellFixture({
  id: ThreadId.make("thread"),
  title: "Billing agent",
  environmentId: EnvironmentId.make("primary"),
  projectId: ProjectId.make("project"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
});

function setup(
  facts: Partial<Extract<PreArchiveFacts, { state: "registered" }>> | null,
  labels: (typeof state.labels)[number][] = [],
) {
  state.facts =
    facts === null
      ? null
      : {
          state: "registered",
          threadId: thread.id,
          projectId: "project",
          participantId: "agent:billing",
          retired: false,
          openExchanges: [],
          placementSubtree: { state: "none" },
          liveCrews: [],
          crewSeat: null,
          ...facts,
        };
  state.labels = labels;
  state.confirms = [];
  state.alerts = [];
}

const askFromCaptain = {
  projectId: "project",
  exchangeId: "exchange:1",
  direction: "inbound" as const,
  replyObligation: "participant-owes-reply" as const,
  counterpartyId: "agent:captain",
  intent: "schema target",
  urgency: "soon" as const,
  openedAt: "2026-10-31T09:00:00.000Z",
};

/** Lets the preflight reads settle so the dialog it raises can be answered. */
async function nextDialog() {
  await vi.waitFor(() => expect(state.confirms.length + state.alerts.length).toBeGreaterThan(0));
}

describe("mobile archive preflight", () => {
  it("archives an agent with nothing open and nothing beneath it without a dialog", async () => {
    setup({});
    expect(await confirmJ5Archive(thread)).toBe(true);
    expect(state.confirms).toEqual([]);
  });

  it("archives a thread that isn't an agent without a dialog", async () => {
    state.facts = {
      state: "not-an-a2a-participant",
      threadId: thread.id,
      openExchanges: [],
      placementSubtree: { state: "not-applicable" },
    };
    state.confirms = [];
    expect(await confirmJ5Archive(thread)).toBe(true);
    expect(state.confirms).toEqual([]);
  });

  it("shows the open asks it will end and archives only on confirm", async () => {
    setup({ openExchanges: [askFromCaptain] }, [
      { participantId: "agent:captain", displayName: "Captain" },
    ]);
    const proceed = confirmJ5Archive(thread);
    await nextDialog();
    const [dialog] = state.confirms;
    expect(dialog?.warning.title).toBe("Archive Billing agent?");
    expect(dialog?.warning.confirmLabel).toBe("Archive anyway");
    expect(dialog?.warning.payload?.openAsks).toEqual([
      {
        direction: "inbound",
        participant: { displayName: "Captain", tooltipParticipantId: null },
        urgency: "soon",
        intent: "schema target",
        openedAt: askFromCaptain.openedAt,
      },
    ]);
    dialog?.resolve(true);
    expect(await proceed).toBe(true);
  });

  it("keeps the thread when the warning is cancelled", async () => {
    setup({ placementSubtree: { state: "known", participantIds: ["agent:child"] } });
    const proceed = confirmJ5Archive(thread);
    await nextDialog();
    state.confirms[0]?.resolve(false);
    expect(await proceed).toBe(false);
  });

  it("refuses a Crew seat and says where Archive crew is", async () => {
    setup({
      crewSeat: { crewInstanceId: "crew:1", crewName: "Review Pair", seat: "critic" },
    });
    expect(await confirmJ5Archive(thread)).toBe(false);
    expect(state.confirms).toEqual([]);
    expect(state.alerts).toEqual([
      {
        title: "Billing agent is seat critic of Crew Review Pair",
        message: expect.stringContaining("web or desktop"),
      },
    ]);
  });

  it("warns that it couldn't check when the preflight read fails", async () => {
    setup(null);
    const proceed = confirmJ5Archive(thread);
    await nextDialog();
    expect(state.confirms[0]?.warning.payload?.factsUnavailable).toBe(true);
    state.confirms[0]?.resolve(true);
    expect(await proceed).toBe(true);
  });
});
