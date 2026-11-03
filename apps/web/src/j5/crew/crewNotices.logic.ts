import {
  crewApprovalSummary,
  crewNoticeLines,
  presentCrewNotice,
  type CrewNoticeMessage,
} from "@t3tools/client-runtime/j5/crew-notices";

/** Completed finishes and successful additions take no row in the timeline. */
export const isHiddenCrewNotice = (message: CrewNoticeMessage): boolean => {
  const notice = presentCrewNotice(message);
  if (notice === null || (notice.kind === "gate" && notice.decision === "declined")) return false;
  return crewApprovalSummary(notice) === null && crewNoticeLines(notice).length === 0;
};

const visibleRows = new WeakMap<object, ReadonlyArray<object>>();

/**
 * The timeline's rows without the hidden Crew notices (FORK.md case 104). It runs on rows already
 * derived, because upstream reads every user message as a turn boundary: dropping a notice before
 * that would merge the Captain turn it started into the one before. The result is the input when
 * nothing is hidden and is cached per input, since the list compares its rows by identity.
 */
export const withoutHiddenCrewNotices = <Row extends { readonly kind: string }>(
  rows: Array<Row>,
): Array<Row> => {
  const cached = visibleRows.get(rows);
  if (cached !== undefined) return cached as Array<Row>;
  const hidden = (row: Row) =>
    row.kind === "message" &&
    "message" in row &&
    isHiddenCrewNotice(row.message as CrewNoticeMessage);
  const visible = rows.some(hidden) ? rows.filter((row) => !hidden(row)) : rows;
  visibleRows.set(rows, visible);
  return visible;
};
