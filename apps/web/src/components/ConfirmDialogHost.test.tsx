import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetConfirmDialogForTests } from "../confirmDialog";
import { ArchiveWarningContent } from "../j5/a2a/ArchiveWarningContent";
import {
  ConfirmationDescription,
  resolveConfirmDialogActionLabel,
  resolveConfirmDialogCopy,
} from "./ConfirmDialogHost";

describe("archive warning confirmation content", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConfirmDialogForTests();
  });

  it("keeps existing string callers' title and description rendering unchanged", () => {
    const markup = renderToStaticMarkup(
      <ConfirmationDescription message="Archive thread?\nThis is the existing description." />,
    );

    expect(resolveConfirmDialogCopy("Archive thread?\nThis is the existing description.")).toEqual({
      title: "Archive thread?",
      description: "This is the existing description.",
    });
    expect(markup).toContain("This is the existing description.");
    expect(resolveConfirmDialogActionLabel()).toBe("Confirm");
  });

  it("renders typed J5 content through the host's optional slot", () => {
    const markup = renderToStaticMarkup(
      <ConfirmationDescription
        message="Archive Release agent?"
        content={
          <ArchiveWarningContent
            payload={{
              threadTitle: "Release agent",
              factsUnavailable: false,
              placement: { state: "none" },
              openAsks: [
                {
                  direction: "inbound",
                  participant: {
                    displayName: "Unnamed participant",
                    tooltipParticipantId: "agent:unknown-counterparty",
                  },
                  urgency: "blocking",
                  intent: "Resolve the migration order before archiving this agent.",
                  openedAt: "2026-09-01T21:00:00.000Z",
                },
                {
                  direction: "outbound",
                  participant: { displayName: "Jackson (inbox)", tooltipParticipantId: null },
                  urgency: "soon",
                  intent: "Confirm the handoff.",
                  openedAt: "2026-09-02T00:45:00.000Z",
                },
              ],
            }}
          />
        }
      />,
    );

    expect(markup).toContain("2 open asks will be terminated (counterparties are notified)");
    expect(markup).toContain(
      'aria-label="Open asks will be terminated and counterparties notified"',
    );
    expect(markup).toContain("Blocking");
    expect(markup).toContain("Soon");
    expect(markup).toContain("From");
    expect(markup).toContain("To");
    expect(markup).toContain("Unnamed participant");
    expect(markup).not.toContain("agent:unknown-counterparty");
    expect(markup).toContain("Jackson (inbox)");
    expect(markup).toContain("open 4h");
    expect(markup).toContain("open 15m");
    expect(markup).toContain("line-clamp-3");
    expect(markup).toContain("Resolve the migration order before archiving this agent.");
    expect(markup).toContain(
      "Worktrees, branches, and pull requests remain. Cleanup is a separate action.",
    );
    expect(markup).not.toContain("waiter");
    expect(resolveConfirmDialogActionLabel("Archive anyway")).toBe("Archive anyway");
  });
});
