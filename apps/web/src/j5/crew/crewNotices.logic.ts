import type { CrewNoticePresentation, FinishedSeat } from "@t3tools/client-runtime/j5/crew-notices";

/** The seats card's title leads with what ended how: "Seat failed", "2 seats finished, 1 failed". */
export const crewSeatsTitle = (seats: ReadonlyArray<FinishedSeat>) => {
  const failed = seats.filter((seat) => seat.runStatus === "failed").length;
  const finished = seats.length - failed;
  if (failed === 0) return seats.length === 1 ? "Seat finished" : `${seats.length} seats finished`;
  if (finished === 0) return failed === 1 ? "Seat failed" : `${failed} seats failed`;
  return `${finished} ${finished === 1 ? "seat" : "seats"} finished, ${failed} failed`;
};

/** "Completed", "Failed", "Interrupted": the run's measured end, with a tone for the pill. */
export const seatRunStatusLabel = (
  runStatus: string,
): { readonly label: string; readonly tone: "good" | "bad" | "warn" | "muted" } => {
  switch (runStatus) {
    case "completed":
      return { label: "Completed", tone: "good" };
    case "failed":
    case "errored":
      return { label: "Failed", tone: "bad" };
    case "interrupted":
    case "cancelled":
      return { label: "Interrupted", tone: "warn" };
    default:
      return { label: runStatus, tone: "muted" };
  }
};

/** The project-relative path the artifacts panel opens, from the notice's logical path. */
export const artifactPanelPath = (logicalPath: string) =>
  logicalPath.startsWith("artifacts/") ? logicalPath.slice("artifacts/".length) : logicalPath;

/** The card's title: what was decided and, for an approval, whether the launch went whole. */
export const crewGateTitle = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) => {
  if (notice.decision === "declined")
    return notice.requestKind === "roster" ? "Crew declined" : "Seat declined";
  const failed = notice.failures.length + notice.notCreated.length;
  if (failed > 0)
    return notice.requestKind === "roster"
      ? `Crew launched, ${failed} ${failed === 1 ? "seat" : "seats"} failed`
      : "Seat failed";
  return notice.requestKind === "roster" ? "Crew launched" : "Seat added";
};

/** The card's last line: what is true of the seats now that the report has been read. */
export const crewGateFooter = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) => {
  if (notice.decision === "declined")
    return "The Captain can revise the request and propose again.";
  const parts: Array<string> = [];
  if (notice.failures.length > 0)
    parts.push(
      `${notice.failures.length} ${notice.failures.length === 1 ? "seat" : "seats"} failed; the Captain has each reason.`,
    );
  if (notice.notCreated.length > 0)
    parts.push(
      `${notice.notCreated.length} ${notice.notCreated.length === 1 ? "seat was" : "seats were"} never created; the Captain can ask for ${notice.notCreated.length === 1 ? "it" : "them"} again.`,
    );
  if (notice.pendingSeats.length > 0)
    parts.push(
      `${notice.pendingSeats.length} ${notice.pendingSeats.length === 1 ? "seat has" : "seats have"} no confirmed provider activity after a minute.`,
    );
  if (parts.length > 0) return parts.join(" ");
  return notice.requestKind === "roster"
    ? "Every seat started with the brief and this roster."
    : "The new seat started with the brief and the current roster.";
};
