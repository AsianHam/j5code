import { useAtomValue } from "@effect/atom-react";
import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { useParticipantLabels } from "../a2a/ParticipantIdentitiesClient";
import { Button } from "../../components/ui/button";
import { j5Environment } from "../state";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import type { CrewProposal, CrewProposalSeat } from "./crewProposalsClient";
import { readCrewProposalDraft, saveCrewProposalDraft } from "./crewProposalDraftStore";
import { crewProposalRows, crewProposalRoster, newCrewProposalRow } from "./crewProposalDraft";
import { describePersonaSwap, removedSeatSteps, stepTitle, unownedSteps } from "./crewPlaybookPlan";
import { CrewProposalMemberDialog } from "./CrewProposalMemberDialog";
import type { CrewProposalRow } from "./crewProposalDraft";
import { CrewProposalMemberRow } from "./CrewProposalMemberRow";
import { useCrewMemberModels, useCrewMemberReasoning } from "./useCrewMemberModels";
import { useCrewProposalPreview } from "./useCrewProposalPreview";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { useCanOperateThread } from "../sharing/access";

function CaptainLabel(props: { environmentId: EnvironmentId; participantId: string }) {
  const labels = useParticipantLabels(props.environmentId, [props.participantId]);
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        Captain: {labels.get(props.participantId) ?? props.participantId}
      </TooltipTrigger>
      <TooltipPopup>{props.participantId}</TooltipPopup>
    </Tooltip>
  );
}

export function CrewProposalCard(props: {
  readonly proposal: CrewProposal;
  readonly environmentId: EnvironmentId | null;
  readonly busy: boolean;
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly contentId: string;
    readonly onToggle: () => void;
  };
  readonly onResolve: (
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
    approvalToken?: string,
  ) => void;
  readonly onOpenCaptain?: (() => void) | undefined;
}) {
  const { proposal } = props;
  const permitted = useAtomValue(
    j5Environment.resolveCrewProposal.permissionAtom(props.environmentId),
  );
  const writesToCaptain = useCanOperateThread(
    props.environmentId,
    proposal.captainThreadId as ThreadId,
  );
  const canResolve = permitted && writesToCaptain;
  const memberModels = useCrewMemberModels(
    props.environmentId,
    proposal.captainThreadId as ThreadId,
  );
  const memberReasoning = useCrewMemberReasoning(
    props.environmentId,
    proposal.captainThreadId as ThreadId,
  );
  const [rows, setRows] = useState(
    () =>
      readCrewProposalDraft(props.environmentId, proposal.id) ??
      crewProposalRows(proposal.requestedSeats),
  );
  const changeRows = (next: typeof rows) => {
    saveCrewProposalDraft(props.environmentId, proposal.id, next);
    setRows(next);
  };
  const [editing, setEditing] = useState<CrewProposalRow | null>(null);
  const [fullBrief, setFullBrief] = useState(false);
  const briefId = useId();
  const nextRow = useRef(
    rows.reduce(
      (next, row) =>
        row.id.startsWith("added:") ? Math.max(next, Number(row.id.slice(6)) + 1) : next,
      0,
    ),
  );
  const addButton = useRef<HTMLButtonElement>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const catalog = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const agents =
    catalog.data == null
      ? []
      : presentAgentPersonaCatalog(catalog.data).filter(
          (agent) => agent.availability === "available",
        );
  const roster = crewProposalRoster(rows);
  const { seats, errors } = roster;
  const preview = useCrewProposalPreview(
    props.environmentId,
    proposal.id,
    seats,
    props.busy,
    errors.size === 0,
  );
  const playbook = preview.data?.playbook ?? proposal.playbook ?? null;
  const unowned =
    preview.data?.unownedSteps ?? (proposal.kind === "roster" ? unownedSteps(playbook, seats) : []);
  const titles = (ids: ReadonlyArray<string>) =>
    ids.map((id) => stepTitle(playbook, id)).join(", ");
  const canApprove =
    !props.busy &&
    canResolve &&
    editing === null &&
    rows.length > 0 &&
    errors.size === 0 &&
    preview.data !== null;

  return (
    <li
      className={props.onOpenCaptain ? "rounded-lg border border-border p-4" : undefined}
      data-testid={`crew-proposal-${proposal.id}`}
    >
      {props.disclosure ? (
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={props.disclosure.expanded ? "Collapse Crew proposal" : "Expand Crew proposal"}
          aria-expanded={props.disclosure.expanded}
          aria-controls={props.disclosure.contentId}
          onClick={props.disclosure.onToggle}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ComposerBanner.Icon>
            <UsersIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>Crew proposal</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>
              {rows.length} {rows.length === 1 ? "member" : "members"}
            </ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={props.disclosure.expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      ) : (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug">{proposal.displayName}</h2>
            {props.onOpenCaptain && props.environmentId !== null ? (
              <div className="mt-1 text-xs text-muted-foreground">
                <CaptainLabel
                  environmentId={props.environmentId}
                  participantId={proposal.captainParticipantId}
                />
              </div>
            ) : null}
          </div>
          {props.onOpenCaptain ? (
            <Button size="sm" variant="ghost" onClick={props.onOpenCaptain}>
              Open Captain
            </Button>
          ) : null}
        </div>
      )}
      <div
        id={props.disclosure?.contentId}
        role={props.disclosure ? "region" : undefined}
        aria-label={props.disclosure ? "Crew proposal roster" : undefined}
        hidden={props.disclosure?.expanded === false}
        className={props.disclosure ? "px-3 pb-3 pt-1" : undefined}
      >
        <ComposerBanner.Scroll className={props.disclosure ? undefined : "max-h-none"}>
          <div className="mb-3 text-sm text-muted-foreground">
            <p
              id={briefId}
              className={
                fullBrief
                  ? "whitespace-pre-wrap break-words"
                  : "line-clamp-2 whitespace-pre-wrap break-words"
              }
            >
              {proposal.brief}
            </p>
            <Button
              type="button"
              size="xs"
              variant="link"
              aria-expanded={fullBrief}
              aria-controls={briefId}
              onClick={() => setFullBrief((full) => !full)}
            >
              {fullBrief ? "View less" : "View more"}
            </Button>
          </div>
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
          <ul className="divide-y divide-border border-y border-border/70">
            {rows.map((row, index) => {
              const seat = seats[index]!;
              const runtime = preview.runtimeSeats?.find(
                (candidate) => candidate.seat === seat.seat,
              );
              return (
                <CrewProposalMemberRow
                  key={row.id}
                  row={row}
                  environmentId={props.environmentId}
                  runtime={runtime}
                  disabled={props.busy || !canResolve}
                  canRemove={rows.length > 1}
                  runtimeLoading={preview.loading}
                  error={errors.get(row.id)}
                  onOpen={(trigger) => {
                    editorTrigger.current = trigger;
                    setEditing(row);
                  }}
                  onRemove={() => {
                    addButton.current?.focus();
                    changeRows(rows.filter((candidate) => candidate.id !== row.id));
                  }}
                >
                  {seat.steps?.length ? (
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      Steps: {titles(seat.steps)}
                    </p>
                  ) : null}
                  {(runtime !== undefined
                    ? (runtime.personaSwaps ?? [])
                    : seat.agentId === row.original?.agentId
                      ? (seat.personaSwaps ?? [])
                      : []
                  ).map((swap) => (
                    <p key={swap.stepId} className="mt-1 break-words text-xs text-warning">
                      {stepTitle(playbook, swap.stepId)} {describePersonaSwap(swap, seat.seat)}
                    </p>
                  ))}
                </CrewProposalMemberRow>
              );
            })}
          </ul>
          {playbook === null ? null : (
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {removedSeatSteps(proposal.requestedSeats, seats).map(({ seat, steps }) => (
                <p key={seat} role="status">
                  Removing {seat} leaves {titles(steps)} unowned.
                </p>
              ))}
              {unowned.length ? (
                <p className="break-words">Unowned steps, done by the Captain: {titles(unowned)}</p>
              ) : null}
            </div>
          )}
          {preview.error ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="text-xs text-destructive" role="alert">
                {preview.error}
              </p>
              <Button
                disabled={props.busy || props.environmentId === null || errors.size > 0}
                size="sm"
                type="button"
                variant="outline"
                onClick={preview.refresh}
              >
                Refresh runtime
              </Button>
            </div>
          ) : null}
        </ComposerBanner.Scroll>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button
            ref={addButton}
            aria-label="Add crew member"
            disabled={props.busy || !canResolve}
            size="sm"
            type="button"
            variant="ghost"
            onClick={(event) => {
              editorTrigger.current = event.currentTarget;
              const row = newCrewProposalRow(`added:${nextRow.current++}`);
              setEditing(row);
            }}
          >
            <PlusIcon className="size-4" />
            Add member
          </Button>
          <div className="flex items-center gap-2">
            <Button
              disabled={props.busy || !canResolve}
              size="sm"
              type="button"
              variant="outline"
              onClick={() => props.onResolve("decline", seats)}
            >
              Decline
            </Button>
            <button
              disabled={!canApprove}
              type="button"
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-foreground bg-foreground px-3 text-xs font-medium text-background hover:bg-foreground/90 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
              onClick={() => {
                if (!canApprove || preview.data === null) return;
                const approvalToken = preview.data.approvalToken;
                preview.refresh();
                props.onResolve("approve", seats, approvalToken);
              }}
            >
              {props.busy
                ? "Working…"
                : proposal.kind === "roster"
                  ? "Approve Crew"
                  : "Approve member"}
            </button>
          </div>
        </div>
      </div>
      {editing && canResolve ? (
        <CrewProposalMemberDialog
          key={editing.id}
          row={editing}
          returnFocus={editorTrigger}
          rows={rows}
          proposalId={proposal.id}
          previewSeatName={editing.original?.seat ?? proposal.requestedSeats[0]!.seat}
          environmentId={props.environmentId}
          workspaceOptions={preview.workspaceOptions}
          memberModels={memberModels}
          memberReasoning={memberReasoning}
          agents={agents}
          disabled={props.busy}
          onClose={() => setEditing(null)}
          onSave={(value) => {
            changeRows(
              editing.original === null
                ? [...rows, { ...editing, value }]
                : rows.map((row) => (row.id === editing.id ? { ...row, value } : row)),
            );
            setEditing(null);
          }}
        />
      ) : null}
    </li>
  );
}
