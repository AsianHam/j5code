import type { ArchiveWarningRow } from "@t3tools/client-runtime/j5/archive-flow";

const URGENCY_RANK = { blocking: 0, soon: 1, fyi: 2 } as const;

/** The asks most likely to hurt come first; the rest keep the server's order. */
export const asksByUrgency = (rows: ReadonlyArray<ArchiveWarningRow>) =>
  [...rows].sort(
    (left, right) =>
      (left.urgency === null ? 3 : URGENCY_RANK[left.urgency]) -
      (right.urgency === null ? 3 : URGENCY_RANK[right.urgency]),
  );
