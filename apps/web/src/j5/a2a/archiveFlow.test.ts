import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  archiveWithPreflight,
  formatArchiveWarning,
  needsArchiveWarning,
  type ArchiveWarningConfirmation,
} from "./archiveFlow";
import * as client from "./archiveFlowClient";

const registered = (overrides: Partial<client.PreArchiveFacts> = {}): client.ArchivePreflight => ({
  facts: {
    state: "registered",
    threadId: ThreadId.make("thread:archive-flow"),
    projectId: "project:archive-flow",
    participantId: "agent:archive-flow",
    retired: false,
    openExchanges: [],
    placementSubtree: { state: "none" },
    liveCrews: [],
    crewSeat: null,
    ...overrides,
  } as Extract<client.PreArchiveFacts, { state: "registered" }>,
  participantLabels: new Map([
    ["agent:waiter", "Waiter"],
    ["agent:recipient", "Recipient"],
    ["agent:child", "Child"],
    ["agent:critic", "Critic"],
  ]),
});

const reviewPair: client.LiveCrew = {
  crewInstanceId: "crew:review-pair",
  crewName: "Review Pair",
  seats: [
    { seat: "builder", participantId: "agent:builder", runningTurn: false, openAsks: 0 },
    { seat: "critic", participantId: "agent:critic", runningTurn: true, openAsks: 1 },
  ],
};

const archiveThreadRef = scopeThreadRef(
  "environment:archive-flow" as never,
  ThreadId.make("thread:archive-flow"),
);

describe("archive flow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a measured clean participant quiet", () => {
    expect(needsArchiveWarning(registered())).toBe(false);
  });

  it("builds every consequential fact into the existing dialog's two-line rows", () => {
    const inboundOpenedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const outboundOpenedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const preflight = registered({
      openExchanges: [
        {
          projectId: "project:archive-flow",
          exchangeId: "exchange:inbound",
          direction: "inbound",
          replyObligation: "participant-owes-reply",
          counterpartyId: "agent:waiter",
          intent: "Review the release",
          urgency: "blocking",
          openedAt: inboundOpenedAt,
        },
        {
          projectId: "project:archive-flow",
          exchangeId: "exchange:outbound",
          direction: "outbound",
          replyObligation: "counterparty-owes-reply",
          counterpartyId: "agent:recipient",
          intent: "Send the final note",
          urgency: "soon",
          openedAt: outboundOpenedAt,
        },
      ],
      placementSubtree: { state: "known", participantIds: ["agent:child"] },
    });

    const warning = formatArchiveWarning({ threadTitle: "Release agent", preflight });
    const markup = renderToStaticMarkup(warning.content);
    expect(needsArchiveWarning(preflight)).toBe(true);
    expect(warning.message).toBe("Archive Release agent?");
    expect(warning.confirmLabel).toBe("Archive anyway");
    expect(markup).toContain("1 agent placed under Release agent keeps running:");
    expect(markup).toContain("Child");
    expect(markup).toContain("2 open asks will be terminated — counterparties are notified");
    expect(markup).toContain("Blocking");
    expect(markup).toContain("From");
    expect(markup).toContain("Waiter");
    expect(markup).toContain("Review the release");
    expect(markup).toContain("Soon");
    expect(markup).toContain("To");
    expect(markup).toContain("Recipient");
    expect(markup).toContain("Send the final note");
  });

  it("lists a Captain's live Crews seat by seat and leaves the retiring to the server", async () => {
    const preflight = registered({ liveCrews: [reviewPair] });
    expect(needsArchiveWarning(preflight)).toBe(true);
    const warning = formatArchiveWarning({ threadTitle: "Captain", preflight });
    const markup = renderToStaticMarkup(warning.content);
    expect(warning.confirmLabel).toBe("Archive anyway");
    expect(markup).toContain("A Captain is never archived alone.");
    expect(markup).toContain("Review Pair");
    expect(markup).toContain("Critic");
    expect(markup).toContain("running turn, 1 open ask");

    // The lifecycle cascade retires the Crews once the archive commits; the delegate only archives.
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(preflight);
    const archive = vi.fn(async () => "archived");
    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Captain",
        confirm: async () => true,
        archive,
      }),
    ).resolves.toBe("archived");
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("names the agents beneath that keep running, leaving the Crew's seats to the Crew", () => {
    const preflight = registered({
      liveCrews: [reviewPair],
      placementSubtree: { state: "known", participantIds: ["agent:child", "agent:critic"] },
    });
    const markup = renderToStaticMarkup(
      formatArchiveWarning({ threadTitle: "Captain", preflight }).content,
    );
    const keptRunning = markup.slice(markup.indexOf("keeps running:"));
    expect(markup).toContain("1 agent placed under Captain keeps running:");
    expect(keptRunning).toContain("Child");
    expect(keptRunning).not.toContain("Critic");
  });

  it("refuses to archive a Crew seat on its own, as archive_agent does for agents", async () => {
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(
      registered({
        crewSeat: { crewInstanceId: "crew:review-pair", crewName: "Review Pair", seat: "critic" },
      }),
    );
    const confirm = vi.fn(async () => true);
    const archive = vi.fn(async () => "archived");
    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Critic",
        confirm,
        archive,
      }),
    ).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("treats a failed Crew read as a fact to warn about, not as no Crews", () => {
    const failed = registered({ liveCrews: null });
    expect(needsArchiveWarning(failed)).toBe(true);
    expect(
      renderToStaticMarkup(
        formatArchiveWarning({ threadTitle: "Captain", preflight: failed }).content,
      ),
    ).toContain("Crews it commands: couldn&#x27;t check.");
    expect(needsArchiveWarning(registered({ liveCrews: [] }))).toBe(false);
  });

  it("never presents an unreadable preflight as an empty clean list", () => {
    expect(needsArchiveWarning({ facts: null, participantLabels: new Map() })).toBe(true);
    expect(
      renderToStaticMarkup(
        formatArchiveWarning({
          threadTitle: "Archive target",
          preflight: registered({
            placementSubtree: { state: "unknown", reason: "placement-query-failed" },
          }),
        }).content,
      ),
    ).toContain("Placement subtree: couldn&#x27;t check.");
  });

  it("keeps unknown raw ids out of rows while retaining them only for a tooltip", () => {
    const unknownParticipantId = "agent:unresolved-counterparty";
    const preflight = registered({
      openExchanges: [
        {
          projectId: "project:archive-flow",
          exchangeId: "exchange:unknown",
          direction: "inbound",
          replyObligation: "participant-owes-reply",
          counterpartyId: unknownParticipantId,
          intent: "Need an answer before archive",
          urgency: "fyi",
          openedAt: new Date().toISOString(),
        },
      ],
    });

    const warning = formatArchiveWarning({ threadTitle: "Archive target", preflight });
    const markup = renderToStaticMarkup(warning.content);
    expect(warning.message).not.toContain(unknownParticipantId);
    expect(markup).toContain("Unnamed participant");
    expect(markup).not.toContain(unknownParticipantId);
  });

  it("marks a resolved human counterparty as an inbox recipient", () => {
    const humanParticipantId = "human:jackson";
    const preflight = registered({
      openExchanges: [
        {
          projectId: "project:archive-flow",
          exchangeId: "exchange:human",
          direction: "outbound",
          replyObligation: "counterparty-owes-reply",
          counterpartyId: humanParticipantId,
          intent: "Please confirm the rollout",
          urgency: "soon",
          openedAt: new Date().toISOString(),
        },
      ],
    });
    const withHumanLabel = {
      ...preflight,
      participantLabels: new Map([...preflight.participantLabels, [humanParticipantId, "Jackson"]]),
    };

    expect(
      renderToStaticMarkup(
        formatArchiveWarning({ threadTitle: "Archive target", preflight: withHumanLabel }).content,
      ),
    ).toContain("Jackson (inbox)");
  });

  it("opens exactly one destructive confirmation only when facts warrant it", async () => {
    const preflight = registered({
      placementSubtree: { state: "unknown", reason: "placement-query-failed" },
    });
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(preflight);
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Archive Archive target?" }),
    );
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("warns and archives if production preflight reading fails", async () => {
    vi.spyOn(client, "readArchivePreflight").mockRejectedValue(new Error("network unavailable"));
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(renderToStaticMarkup(confirm.mock.calls[0]?.[0]?.content ?? null)).toContain(
      "Couldn&#x27;t check open asks or the placement subtree.",
    );
    expect(confirm.mock.calls[0]?.[0]?.confirmLabel).toBe("Archive");
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("archives a measured clean participant without the J5 warning", async () => {
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(registered());
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(confirm).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("preserves a requested plain confirmation for a measured clean participant", async () => {
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(registered());
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const confirmCleanArchive = vi.fn(async () => false);
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        confirmCleanArchive,
        archive,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).not.toHaveBeenCalled();
    expect(confirmCleanArchive).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
  });

  it("warns before archiving a consequential non-primary thread", async () => {
    const remoteThreadRef = scopeThreadRef(
      "environment:remote" as never,
      ThreadId.make("thread:remote-archive-flow"),
    );
    vi.spyOn(client, "readArchivePreflight").mockImplementation(async (threadRef) => {
      expect(threadRef).toEqual(remoteThreadRef);
      return registered({
        openExchanges: [
          {
            projectId: "project:archive-flow",
            exchangeId: "exchange:remote-inbound",
            direction: "inbound",
            replyObligation: "participant-owes-reply",
            counterpartyId: "agent:waiter",
            intent: "Wait for the remote archive",
            urgency: "blocking",
            openedAt: new Date().toISOString(),
          },
        ],
      });
    });
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: remoteThreadRef,
        threadTitle: "Remote archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(renderToStaticMarkup(confirm.mock.calls[0]?.[0]?.content ?? null)).toContain(
      "Wait for the remote archive",
    );
    expect(archive).toHaveBeenCalledTimes(1);
  });
});
