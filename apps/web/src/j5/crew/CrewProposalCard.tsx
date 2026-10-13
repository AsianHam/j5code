import { useAtomValue } from "@effect/atom-react";
import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { Button } from "../../components/ui/button";
import { j5Environment } from "../state";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import type { CrewProposal, CrewProposalSeat } from "./crewProposalsClient";
import { addSeat, describeSeatAgent, removeSeat, saveSeat } from "./crewProposalDraft";
import { describePersonaSwap, removedSeatSteps, stepTitle, unownedSteps } from "./crewPlaybookPlan";
import { CrewSeatDialog } from "./CrewSeatDialog";
import { crewSeatStopsForApprovals, describeCrewSeatWorkspace } from "./crewSeatRuntime";
import { useCanOperateThread } from "../sharing/guestAccess";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { useParticipantLabels } from "../a2a/ParticipantIdentitiesClient";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

function CaptainLabel(props: {
  readonly environmentId: EnvironmentId;
  readonly participantId: string;
}) {
  const labels = useParticipantLabels(props.environmentId, [props.participantId]);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="truncate" />}>
        {labels.get(props.participantId) ?? "Captain"}
      </TooltipTrigger>
      <TooltipPopup>{props.participantId}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The human gate for one Crew request. The Captain's seats arrive with reasons; the user may drop
 * seats, add personas from the library or a custom seat with its own instructions, then approve the
 * final roster or decline the whole request.
 */
export function CrewProposalCard(props: {
  readonly proposal: CrewProposal;
  readonly environmentId: EnvironmentId | null;
  readonly busy: boolean;
  readonly onResolve: (
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
    approvalToken?: string,
  ) => void;
  /**
   * The roster is answered as it was proposed: seats are shown and cannot be changed. True for a
   * guest, whose answer is checked against their level on the Captain's thread.
   */
  readonly asProposed?: boolean;
  /** Omitted when the card already sits in the Captain's thread. */
  readonly onOpenCaptain?: (() => void) | undefined;
}) {
  const { proposal } = props;
  // Resolving a roster launches or refuses agents; the command says whether this session may.
  const permitted = useAtomValue(
    j5Environment.resolveCrewProposal.permissionAtom(props.environmentId),
  );
  const mayWrite = useCanOperateThread(props.environmentId, proposal.captainThreadId as ThreadId);
  const canResolve = props.asProposed === true ? permitted && mayWrite : permitted;
  const seatsCanChange = props.asProposed !== true;
  const [seats, setSeats] = useState<ReadonlyArray<CrewProposalSeat>>(proposal.requestedSeats);
  const [editor, setEditor] = useState<{
    readonly seat: CrewProposalSeat | null;
    readonly runtime?: CrewProposalSeatRuntime | undefined;
  } | null>(null);
  const catalog = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const rows = useMemo(
    () =>
      catalog.data === null || catalog.data === undefined
        ? []
        : presentAgentPersonaCatalog(catalog.data),
    [catalog.data],
  );
  const agents = useMemo(() => rows.filter((agent) => agent.availability === "available"), [rows]);
  const preview = useCrewProposalPreview(
    props.environmentId,
    proposal.id,
    seats,
    props.busy,
    props.asProposed === true,
  );
  const runtimeFor = (seat: CrewProposalSeat) =>
    preview.runtimeSeats?.find((row) => row.seat === seat.seat);
  const stopping = seats.filter((seat) => crewSeatStopsForApprovals(seat, runtimeFor(seat))).length;
  // The preview carries the plan the approval token binds; the list's copy is only a first paint.
  const playbook = preview.data?.playbook ?? proposal.playbook ?? null;
  const unowned =
    preview.data?.unownedSteps ??
    // An addition's other steps belong to live members only the server knows about.
    (proposal.kind === "roster" ? unownedSteps(playbook, seats) : []);
  const titles = (ids: ReadonlyArray<string>) =>
    ids.map((id) => stepTitle(playbook, id)).join(", ");

  return (
    <li
      className="rounded-lg border border-border p-4"
      data-testid={`crew-proposal-${proposal.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="warning">
              <span className="uppercase tracking-wide">
                {proposal.kind === "roster" ? "New crew" : "Add a seat"}
              </span>
            </Badge>
            {props.environmentId === null ? (
              <span>Captain</span>
            ) : (
              <CaptainLabel
                key={`${props.environmentId}:${proposal.captainParticipantId}`}
                environmentId={props.environmentId}
                participantId={proposal.captainParticipantId}
              />
            )}
          </div>
          <h2 className="mt-1 text-base font-semibold leading-snug">{proposal.displayName}</h2>
        </div>
        {props.onOpenCaptain === undefined ? null : (
          <Button size="sm" type="button" variant="ghost" onClick={props.onOpenCaptain}>
            Open Captain
          </Button>
        )}
      </div>
      {/* The brief is context, not the decision: a clamped excerpt sits in the summary so the
          seats and Approve stay in view, and the full text opens in place before approving. */}
      <details className="group/brief mt-3 max-w-[72ch] text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Brief
          <span
            aria-hidden="true"
            className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90 group-open/brief:hidden"
          >
            {proposal.brief}
          </span>
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-foreground/90">{proposal.brief}</p>
      </details>
      {playbook === null ? null : (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>
            Follows playbook: <span className="text-foreground">{playbook.title}</span>
          </p>
          {playbook.issue === null ? null : (
            <p className="text-destructive" role="alert">
              {playbook.issue}
            </p>
          )}
        </div>
      )}
      <ul className="mt-3 space-y-2">
        {seats.map((seat) => {
          const runtime = runtimeFor(seat);
          return (
            <li
              key={seat.seat}
              className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                <div className="min-w-0 space-y-0.5 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <h3 className="break-words text-sm font-medium text-foreground">{seat.seat}</h3>
                    <span>
                      {seat.agentId === null
                        ? "Custom crew member"
                        : describeSeatAgent(rows, seat.agentId)}
                    </span>
                    {crewSeatStopsForApprovals(seat, runtime) ? (
                      <Badge variant="warning" size="sm">
                        Stops for approvals
                      </Badge>
                    ) : null}
                  </div>
                  {runtime ? (
                    <p className="break-words">
                      {[
                        runtime.provider,
                        runtime.model,
                        runtime.reasoning,
                        runtime.access,
                        ...(runtime.workspace === undefined
                          ? []
                          : [describeCrewSeatWorkspace(runtime.workspace)]),
                      ].join(" · ")}
                      <span className="ml-2">Harness: {runtime.harness}</span>
                    </p>
                  ) : (
                    <p role="status">
                      {preview.loading ? "Checking runtime…" : "Runtime unavailable"}
                    </p>
                  )}
                  {seat.instructions ? (
                    <details>
                      <summary className="cursor-pointer">Instructions</summary>
                      <p className="mt-1 whitespace-pre-wrap break-words text-foreground/90">
                        {seat.instructions}
                      </p>
                    </details>
                  ) : null}
                  {seat.steps !== undefined && seat.steps.length > 0 ? (
                    <p className="break-words">Steps: {titles(seat.steps)}</p>
                  ) : null}
                  {(runtime === undefined
                    ? (seat.personaSwaps ?? [])
                    : (runtime.personaSwaps ?? [])
                  ).map((swap) => (
                    <p key={swap.stepId} className="break-words text-warning">
                      {stepTitle(playbook, swap.stepId)} {describePersonaSwap(swap, seat.seat)}
                    </p>
                  ))}
                </div>
                <div className="flex items-center justify-self-end gap-1" hidden={!seatsCanChange}>
                  <Button
                    aria-label={`Edit seat ${seat.seat}`}
                    disabled={props.busy}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setEditor({ seat, runtime })}
                  >
                    <PencilIcon className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    aria-label={`Remove seat ${seat.seat}`}
                    disabled={props.busy || seats.length === 1}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setSeats(removeSeat(seats, seat.seat))}
                  >
                    <XIcon className="size-3.5" />
                    Remove
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {playbook === null ? null : (
        <div className="mt-3 space-y-0.5 text-xs text-muted-foreground">
          {removedSeatSteps(proposal.requestedSeats, seats).map(({ seat, steps }) => (
            <p key={seat} role="status">
              Removing {seat} leaves {titles(steps)} unowned.
            </p>
          ))}
          {unowned.length === 0 ? null : (
            <p className="break-words">Unowned steps, done by the Captain: {titles(unowned)}</p>
          )}
        </div>
      )}
      <Button
        className="mt-3"
        aria-label="Add crew member"
        hidden={!seatsCanChange}
        disabled={props.busy}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => setEditor({ seat: null })}
      >
        <PlusIcon className="size-4" />
        Add member
      </Button>
      {editor !== null ? (
        <CrewSeatDialog
          seat={editor.seat}
          proposalId={proposal.id}
          previewSeatName={editor.seat?.seat ?? proposal.requestedSeats[0]!.seat}
          runtime={editor.runtime}
          workspaceOptions={preview.data?.workspaceOptions}
          environmentId={props.environmentId}
          agents={agents}
          disabled={props.busy}
          onClose={() => setEditor(null)}
          onSave={(draft) => {
            const next =
              editor.seat === null
                ? addSeat(seats, draft)
                : saveSeat(seats, editor.seat.seat, draft);
            if (next.error === null) setSeats(next.seats);
            return next.error;
          }}
        />
      ) : null}
      {preview.error ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive" role="alert">
            {preview.error}
          </p>
          <Button
            disabled={props.busy || props.environmentId === null}
            size="sm"
            type="button"
            variant="outline"
            onClick={preview.refresh}
          >
            Refresh runtime
          </Button>
        </div>
      ) : null}
      {stopping > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {stopping === 1
            ? "1 seat will stop for approvals in its own thread."
            : `${stopping} seats will stop for approvals in their own threads.`}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button
          disabled={props.busy || !canResolve}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => props.onResolve("decline", seats)}
        >
          Decline
        </Button>
        <Button
          disabled={props.busy || !canResolve || seats.length === 0 || preview.data === null}
          size="sm"
          type="button"
          onClick={() => {
            if (preview.data === null) return;
            const approvalToken = preview.data.approvalToken;
            preview.refresh();
            props.onResolve("approve", seats, approvalToken);
          }}
        >
          {props.busy
            ? "Working…"
            : preview.loading
              ? "Loading runtime…"
              : `Approve ${seats.length} ${seats.length === 1 ? "seat" : "seats"}`}
        </Button>
      </div>
    </li>
  );
}
