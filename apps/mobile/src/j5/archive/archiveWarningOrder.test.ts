import type { ArchiveWarningRow } from "@t3tools/client-runtime/j5/archive-flow";
import { describe, expect, it } from "vite-plus/test";

import { asksByUrgency } from "./archiveWarningOrder";

const ask = (intent: string, urgency: ArchiveWarningRow["urgency"]): ArchiveWarningRow => ({
  direction: "inbound",
  participant: { displayName: "Captain", tooltipParticipantId: null },
  urgency,
  intent,
  openedAt: "2026-10-31T09:00:00.000Z",
});

describe("archive warning ask order", () => {
  it("puts blocking asks first and keeps the server's order within an urgency", () => {
    const rows = [
      ask("a", null),
      ask("b", "fyi"),
      ask("c", "blocking"),
      ask("d", "soon"),
      ask("e", "blocking"),
    ];
    expect(asksByUrgency(rows).map((row) => row.intent)).toEqual(["c", "e", "d", "b", "a"]);
  });
});
