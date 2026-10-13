import { modelSelectionsEqual } from "@t3tools/shared/model";
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import type { CrewProposal, CrewProposalSeat } from "./AgentCrewProposalService.ts";
import { formatRunFailureField } from "./runFailures.ts";

/**
 * How a seat's launch and first turn went: `started` once provider activity is recorded (or the
 * run completed), `failed` when the run failed before the report, `pending` when the report's
 * window closed before either. `not_started` is a seat whose thread exists but whose home or brief
 * did not go through, so it has no first turn; `not_created` is a seat whose thread was never
 * created, which is not on the roster and cannot be messaged.
 */
export type SeatStartVerdict =
  | { readonly kind: "started" }
  | {
      readonly kind: "failed";
      readonly runId: string;
      readonly runStatus: string;
      readonly failure: OrchestrationV2ProviderFailure | null;
    }
  | { readonly kind: "pending" }
  | { readonly kind: "not_started"; readonly detail: string }
  | { readonly kind: "not_created"; readonly detail: string };

export interface CrewRosterChanges {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly runtimeChanged: ReadonlyArray<string>;
  readonly instructionsChanged: ReadonlyArray<string>;
}

/**
 * What the person changed against the Captain's request, using the saved edits rather than
 * materialized runtime defaults. A rename keeps the same persona and reason.
 */
export const crewRosterChanges = (
  requested: ReadonlyArray<CrewProposalSeat>,
  approved: ReadonlyArray<CrewProposalSeat>,
): CrewRosterChanges => {
  const requestedNames = new Set(requested.map(({ seat }) => seat));
  const approvedNames = new Set(approved.map(({ seat }) => seat));
  const added = approved.filter(({ seat }) => !requestedNames.has(seat));
  const removed = requested.filter(({ seat }) => !approvedNames.has(seat));
  const renamed: Array<{ from: string; to: string }> = [];
  for (const gone of removed) {
    const twin = added.find(
      (seat) =>
        seat.agentId === gone.agentId &&
        seat.reason === gone.reason &&
        !renamed.some((pair) => pair.to === seat.seat),
    );
    if (twin !== undefined) renamed.push({ from: gone.seat, to: twin.seat });
  }
  const renamedFrom = new Set(renamed.map(({ from }) => from));
  const renamedTo = new Set(renamed.map(({ to }) => to));
  const retained = approved.flatMap((seat) => {
    const previousName = renamed.find(({ to }) => to === seat.seat)?.from ?? seat.seat;
    const previous = requested.find(({ seat: name }) => name === previousName);
    return previous === undefined ? [] : [{ previous, seat }];
  });
  const runtimeChanged = retained
    .filter(({ previous, seat }) => {
      const sameSelection =
        previous.modelSelection === undefined || seat.modelSelection === undefined
          ? previous.modelSelection === seat.modelSelection
          : modelSelectionsEqual(previous.modelSelection, seat.modelSelection);
      return (
        previous.agentId !== seat.agentId ||
        !sameSelection ||
        previous.runtimeMode !== seat.runtimeMode
      );
    })
    .map(({ seat }) => seat.seat);
  return {
    added: added.filter(({ seat }) => !renamedTo.has(seat)).map(({ seat }) => seat),
    removed: removed.filter(({ seat }) => !renamedFrom.has(seat)).map(({ seat }) => seat),
    renamed,
    runtimeChanged,
    instructionsChanged: retained
      .filter(({ previous, seat }) => previous.instructions !== seat.instructions)
      .map(({ seat }) => seat.seat),
  };
};

/** A launch-step error as one report field: escaped so it cannot add lines or close the block. */
const reportField = (detail: string) =>
  detail.replace(/[&<>\r\n\u2028\u2029]/g, (character) => `&#${character.charCodeAt(0)};`);

const changesLine = (changes: CrewRosterChanges) => {
  const parts = [
    ...(changes.added.length > 0 ? [`added ${changes.added.join(", ")}`] : []),
    ...(changes.removed.length > 0 ? [`removed ${changes.removed.join(", ")}`] : []),
    ...changes.renamed.map(({ from, to }) => `renamed ${from}→${to}`),
    ...(changes.runtimeChanged.length > 0
      ? [`runtime changed: ${changes.runtimeChanged.join(", ")}`]
      : []),
    ...(changes.instructionsChanged.length > 0
      ? [`instructions changed: ${changes.instructionsChanged.join(", ")}`]
      : []),
  ];
  return parts.length === 0 ? "none" : parts.join("; ");
};

// `decided_by` is there only in a shared conversation, where more than one person could have
// answered (Shared conversations AC9); every other Captain reads the notice as it always was.
const head = (proposal: CrewProposal, decision: "approved" | "declined") =>
  `<j5_crew_gate>\nproposal_id: ${proposal.id}\nkind: ${proposal.kind}\ndecision: ${decision}${proposal.decidedBy == null ? "" : `\ndecided_by: ${reportField(proposal.decidedBy)}`}\ncrew_name: ${proposal.displayName}`;

/** The platform-composed notice a Captain receives when the person declines: measured facts only. */
export const crewDeclinedNoticeText = (proposal: CrewProposal) =>
  `${head(proposal, "declined")}\nrequested_seats: ${proposal.requestedSeats.map(({ seat, agentId }) => `${seat}=${agentId ?? ""}`).join(", ")}\n</j5_crew_gate>\n\nThe user declined this crew request. Continue with the seats you have, or revise the request and propose again with a clearer reason.`;

/**
 * The launch report: the approval, what the person changed, and how each seat's first turn went.
 * Posted once every watched seat has a verdict or the window closed, so what it says is true when
 * the Captain reads it (Jackson's dogfood, 2026-09-17). Seats this proposal did not launch (the
 * rest of a Crew an addition joins) carry no `start`.
 */
export const crewLaunchReportText = (input: {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance;
  readonly verdicts: ReadonlyMap<string, SeatStartVerdict>;
  readonly windowMs: number;
  /** The playbook the Crew follows, with its live title (its name when the file can't be read). */
  readonly playbook?: { readonly name: string; readonly title: string } | null;
}) => {
  const { proposal, instance, verdicts } = input;
  const playbook = input.playbook ?? null;
  const changes = crewRosterChanges(
    proposal.requestedSeats,
    proposal.approvedSeats ?? proposal.requestedSeats,
  );
  const started = [...verdicts].filter(([, verdict]) => verdict.kind === "started").length;
  // A seat that exists but never got its first turn is a failed seat to the Captain; the step
  // that failed takes the run status's place.
  const failed = [...verdicts].filter(
    ([, verdict]) => verdict.kind === "failed" || verdict.kind === "not_started",
  );
  const notCreated = [...verdicts].flatMap(([seat, verdict]) =>
    verdict.kind === "not_created" ? [{ seat, detail: verdict.detail }] : [],
  );
  const pending = [...verdicts].filter(([, verdict]) => verdict.kind === "pending");
  const windowSeconds = Math.round(input.windowMs / 1000);
  const launch = `launch: ${started} started, ${failed.length} failed, ${notCreated.length} not created, ${pending.length} start unconfirmed after ${windowSeconds}s`;
  const failedLines = failed.map(([seat, verdict]) =>
    verdict.kind === "not_started"
      ? `seat_failed: ${seat} | not_started | ${reportField(verdict.detail)}`
      : `seat_failed: ${seat} | ${verdict.kind === "failed" ? verdict.runStatus : ""} | ${formatRunFailureField(verdict.kind === "failed" ? verdict.failure : null)}`,
  );
  const notCreatedLines = notCreated.map(
    ({ seat, detail }) => `seat_not_created: ${seat} | ${reportField(detail)}`,
  );
  const pendingLines = pending.map(([seat]) => `seat_pending: ${seat}`);
  const roster = instance.members
    .map((member) => {
      const verdict = verdicts.get(member.seatName);
      const isNew = member.addedVersion === instance.version && proposal.kind === "addition";
      const start =
        verdict === undefined
          ? ""
          : ` start=${verdict.kind === "not_started" || verdict.kind === "not_created" ? "failed" : verdict.kind}`;
      return `- ${member.seatName}: participant_id=${member.participantId} persona=${member.agentId ?? ""} thread_id=${member.threadId}${start}${isNew ? " (new)" : ""}`;
    })
    .join("\n");
  const block = [
    head(proposal, "approved"),
    `crew_instance_id: ${instance.id}`,
    `crew_version: ${instance.version}`,
    `changes: ${changesLine(changes)}`,
    launch,
    ...failedLines,
    ...failed.flatMap(([, verdict]) =>
      verdict.kind === "failed" ? [`failed_run: ${verdict.runId}`] : [],
    ),
    ...notCreatedLines,
    ...pendingLines,
    ...(playbook === null
      ? []
      : [`playbook: ${reportField(playbook.name)} | ${reportField(playbook.title)}`]),
    `roster:\n${roster}`,
    "</j5_crew_gate>",
  ].join("\n");
  const prose: Array<string> = [];
  if (failed.length > 0)
    prose.push(
      `${failed.length} of ${verdicts.size} seats failed; each seat_failed line carries the run's error. The platform raises provider sign-in and permission failures in the human inbox. Re-brief the seat with j5_send_message once the provider works; ask the user about other failures when their help is needed. Seats that started have your brief and this roster.`,
    );
  if (notCreated.length > 0)
    prose.push(
      `${notCreated.length} ${notCreated.length === 1 ? "seat was" : "seats were"} never created (${notCreated.map(({ seat }) => seat).join(", ")}); each seat_not_created line says why. ${notCreated.length === 1 ? "It is" : "They are"} not on the roster and cannot be messaged. If the work still needs ${notCreated.length === 1 ? "that seat" : "those seats"}, ask for ${notCreated.length === 1 ? "it" : "them"} again with j5_request_crew_member.`,
    );
  if (pending.length > 0)
    prose.push(
      `${pending.length} ${pending.length === 1 ? "seat has" : "seats have"} no confirmed provider activity after ${windowSeconds}s; its first turn may still be queued, and you will hear from it when it finishes.`,
    );
  if (failed.length === 0 && notCreated.length === 0 && pending.length === 0)
    prose.push(
      "Your crew is running. Each seat has your brief and this roster; coordinate with j5_send_message.",
    );
  if (playbook !== null && proposal.kind === "roster")
    prose.push(
      `This Crew follows playbook ${playbook.name}. Start it with j5_playbook_start(name: "${playbook.name}", client_request_id, crew_instance_id: "${instance.id}"). The platform hands each step to the seat that owns it; unowned steps are yours.`,
    );
  prose.push(
    "Seats are told to message you with their results; do not ask for the same results again. End your turn and read them as they arrive.",
  );
  return `${block}\n\n${prose.join(" ")}`;
};
