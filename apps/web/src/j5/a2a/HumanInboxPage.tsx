import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProjectId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { scopedInboxItemKey, type ScopedHumanInboxItem } from "@t3tools/contracts/j5";
import { useAtomValue } from "@effect/atom-react";
import {
  j5SourceNotice,
  mergeHumanInboxSources,
  type PresentedHumanInboxItem as HumanInboxItem,
} from "@t3tools/client-runtime/j5/inbox";
import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  InboxIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { useProject, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { answerHumanExchange } from "./humanInboxClient";
import { useScopedParticipantLabels } from "./ParticipantIdentitiesClient";
import { presentParticipantIdentity } from "./ParticipantIdentity";
import { CrewProposalCard } from "../crew/CrewProposalCard";
import { CrewRuntimeRequestsSection } from "../crew/CrewRuntimeRequestsSection";
import type { ScopedCrewRuntimeRequest } from "../crew/crewRuntimeRequests.logic";
import { useCrewRuntimeRequests } from "../crew/crewRuntimeRequestsClient";
import { inboxCrewRequests } from "../crew/crewProposals.logic";
import {
  mergeCrewProposalSources,
  refreshCrewProposals,
  resolveCrewProposal,
  useCrewProposalsRefresh,
  type CrewProposalSeat,
  type ScopedCrewProposal,
} from "../crew/crewProposalsClient";
import {
  answeredInboxQueryAtom,
  answeredInboxSourcesAtom,
  crewProposalSourcesAtom,
  j5Environment,
  openInboxQueryAtom,
  openInboxSourcesAtom,
  refreshJ5Sources,
} from "../state";
import { useLogicalProjects } from "../logicalProjects";
import { createVisibleRefreshHook } from "../useVisibleRefresh";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";

interface HumanInboxAnswerAttempt {
  readonly message: string;
  readonly clientRequestId: string;
}

type HumanInboxAnswers = Readonly<Record<string, string>>;
type SenderLabels = ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>;
/** An item's project, by display name. */
type ProjectNameOf = (item: HumanInboxItem) => string;

const noLabels: ReadonlyMap<string, string> = new Map();

function SenderName({
  item,
  senderLabels,
  className,
}: {
  readonly item: HumanInboxItem;
  readonly senderLabels: SenderLabels;
  readonly className?: string;
}) {
  const sender = presentParticipantIdentity({
    participantId: item.senderId,
    participantLabels: senderLabels.get(item.environmentId) ?? noLabels,
  });
  if (sender.tooltipParticipantId === null)
    return <span className={className}>{sender.label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{sender.label}</TooltipTrigger>
      <TooltipPopup>{sender.tooltipParticipantId}</TooltipPopup>
    </Tooltip>
  );
}

const urgencyPresentation = {
  blocking: { label: "Blocking", variant: "destructive" as const },
  soon: { label: "Soon", variant: "warning" as const },
  fyi: { label: "FYI", variant: "secondary" as const },
};

export const formatAnsweredAgeLabel = (elapsed: string) =>
  elapsed === "just now" ? "answered just now" : elapsed ? `answered ${elapsed} ago` : "answered";

export function captureHumanInboxAnswer(
  event: { readonly currentTarget: { readonly value: string } },
  exchangeId: string,
  setAnswers: (update: (current: HumanInboxAnswers) => HumanInboxAnswers) => void,
) {
  const value = event.currentTarget.value;
  setAnswers((current) => ({
    ...current,
    [exchangeId]: value,
  }));
}

export async function submitHumanInboxAnswer(input: {
  readonly item: ScopedHumanInboxItem;
  readonly message: string;
  readonly attempts: Map<string, HumanInboxAnswerAttempt>;
  readonly randomUUID: () => string;
  readonly send: (
    environmentId: EnvironmentId,
    request: {
      readonly personId: string;
      readonly exchangeId: string;
      readonly message: string;
      readonly clientRequestId: string;
    },
  ) => Promise<unknown>;
  readonly refresh: (environmentId: EnvironmentId, personId: string) => Promise<void>;
  readonly notifyChanged: (environmentId: EnvironmentId) => void;
  readonly onAccepted: () => void;
  readonly setPendingExchangeId: (exchangeId: string | null) => void;
  readonly setError: (message: string | null) => void;
}) {
  const itemKey = scopedInboxItemKey(input.item);
  input.setPendingExchangeId(itemKey);
  input.setError(null);
  try {
    try {
      const previousAttempt = input.attempts.get(itemKey);
      const attempt =
        previousAttempt?.message === input.message
          ? previousAttempt
          : { message: input.message, clientRequestId: input.randomUUID() };
      input.attempts.set(itemKey, attempt);
      await input.send(input.item.environmentId, {
        personId: input.item.personId,
        exchangeId: input.item.exchangeId,
        message: input.message,
        clientRequestId: attempt.clientRequestId,
      });
    } catch (cause) {
      input.setError(cause instanceof Error ? cause.message : "Could not deliver the answer.");
      return;
    }
    input.attempts.delete(itemKey);
    input.notifyChanged(input.item.environmentId);
    input.onAccepted();
    try {
      await input.refresh(input.item.environmentId, input.item.personId);
    } catch {
      input.setError(
        "Answer delivered, but the inbox could not be refreshed. The list may be stale.",
      );
    }
  } finally {
    input.setPendingExchangeId(null);
  }
}

function OpenThreadButton({
  item,
  environmentAvailable,
  onOpen,
}: {
  readonly item: HumanInboxItem;
  readonly environmentAvailable: boolean;
  readonly onOpen: (item: HumanInboxItem) => void;
}) {
  const available = environmentAvailable && item.senderThreadId !== null;
  return (
    <Button
      className="w-fit"
      disabled={!available}
      onClick={() => onOpen(item)}
      size="sm"
      title={
        available
          ? undefined
          : item.senderThreadId === null
            ? "The sender is no longer in the active roster."
            : "No active environment is available."
      }
      type="button"
      variant="ghost"
    >
      Open thread
      <ArrowUpRightIcon aria-hidden className="size-3.5" />
    </Button>
  );
}

/**
 * An agent's message, rendered as the sender's thread renders it. Relative file links resolve
 * against the sender's worktree, or the project's root once the sender has left the roster.
 */
function InboxMessage({ item }: { readonly item: HumanInboxItem }) {
  const threadRef =
    item.senderThreadId === null
      ? null
      : scopeThreadRef(item.environmentId, ThreadId.make(item.senderThreadId));
  const thread = useThreadShell(threadRef);
  const project = useProject(scopeProjectRef(item.environmentId, ProjectId.make(item.projectId)));
  const cwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: thread?.worktreePath ?? null,
      })
    : undefined;
  return (
    <ChatMarkdown
      className="max-w-[72ch] text-sm text-foreground/90"
      cwd={cwd}
      environmentId={item.environmentId}
      lineBreaks={shouldPreserveAssistantLineBreaks(item.message)}
      text={item.message}
      threadRef={threadRef ?? undefined}
    />
  );
}

function OpenInboxItem({
  item,
  answer,
  answerText,
  pendingExchangeId,
  setAnswers,
  onOpenThread,
  senderLabels,
  projectNameOf,
  showEnvironment,
}: {
  readonly item: HumanInboxItem;
  readonly answer: (item: HumanInboxItem) => void;
  readonly senderLabels: SenderLabels;
  readonly projectNameOf: ProjectNameOf;
  readonly answerText: string;
  readonly pendingExchangeId: string | null;
  readonly showEnvironment: boolean;
  readonly setAnswers: (update: (current: HumanInboxAnswers) => HumanInboxAnswers) => void;
  readonly onOpenThread: (item: HumanInboxItem) => void;
}) {
  const urgency = urgencyPresentation[item.urgency];
  const openDuration = formatElapsedDurationLabel(item.openedAt);
  const mayAnswer = useAtomValue(
    j5Environment.answerHumanExchange.permissionAtom(item.environmentId),
  );
  const canAnswer = item.sourceReady && mayAnswer;
  return (
    <li className="border-b border-border/70 last:border-b-0">
      <details className="group/details">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-1 py-4 outline-hidden marker:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:gap-4 [&::-webkit-details-marker]:hidden">
          <Badge className="mt-0.5" variant={urgency.variant}>
            <span className="uppercase tracking-wide">{urgency.label}</span>
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <SenderName
                className="max-w-full truncate font-medium text-foreground/80"
                item={item}
                senderLabels={senderLabels}
              />
              <span aria-hidden>·</span>
              <span className="truncate">{projectNameOf(item)}</span>
              {showEnvironment || !item.connected ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">
                    {showEnvironment ? item.environmentLabel : ""}
                    {item.connected ? "" : showEnvironment ? " (offline)" : "offline"}
                  </span>
                </>
              ) : null}
              {openDuration ? (
                <>
                  <span aria-hidden>·</span>
                  <time className="tabular-nums" dateTime={item.openedAt}>
                    open {openDuration}
                  </time>
                </>
              ) : null}
            </div>
            <h2 className="mt-1 break-words text-pretty text-base font-semibold leading-snug text-foreground">
              {item.intent}
            </h2>
          </div>
          <ChevronRightIcon
            aria-hidden
            className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/details:rotate-90"
          />
        </summary>
        <div className="border-t border-border/50 px-1 pb-5 pt-4 sm:ms-24 sm:px-0 sm:pe-1">
          <InboxMessage item={item} />
          <div className="mt-4 flex flex-col gap-3">
            <Textarea
              aria-label={`Answer ${item.intent}`}
              className="min-h-24 resize-y"
              onChange={(event) =>
                captureHumanInboxAnswer(event, scopedInboxItemKey(item), setAnswers)
              }
              placeholder="Type the answer exactly as it should be delivered"
              value={answerText}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <OpenThreadButton
                environmentAvailable={item.connected}
                item={item}
                onOpen={onOpenThread}
              />
              <Button
                disabled={!canAnswer || pendingExchangeId !== null || answerText.length === 0}
                title={
                  canAnswer
                    ? undefined
                    : "This environment is unavailable or this connection is read-only."
                }
                onClick={() => answer(item)}
                type="button"
              >
                {pendingExchangeId === scopedInboxItemKey(item) ? "Delivering…" : "Answer"}
              </Button>
            </div>
          </div>
        </div>
      </details>
    </li>
  );
}

function AnsweredShelf({
  items,
  onOpenThread,
  senderLabels,
  projectNameOf,
  showEnvironment,
}: {
  readonly items: ReadonlyArray<HumanInboxItem>;
  readonly onOpenThread: (item: HumanInboxItem) => void;
  readonly senderLabels: SenderLabels;
  readonly projectNameOf: ProjectNameOf;
  readonly showEnvironment: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details className="group/shelf border-t border-border pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-sm font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-4 transition-transform duration-150 group-open/shelf:rotate-90"
        />
        Answered
        <span className="tabular-nums text-muted-foreground/70">{items.length}</span>
      </summary>
      <ol className="mt-1 divide-y divide-border/60 ps-6">
        {items.map((item) => {
          const answeredDuration = item.terminalAt
            ? formatElapsedDurationLabel(item.terminalAt)
            : "";
          return (
            <li className="flex min-w-0 items-start gap-3 py-3" key={scopedInboxItemKey(item)}>
              <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-foreground/80">{item.intent}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  <SenderName item={item} senderLabels={senderLabels} /> · {projectNameOf(item)}
                  {showEnvironment ? ` · ${item.environmentLabel}` : ""}
                  {` · ${formatAnsweredAgeLabel(answeredDuration)}`}
                </p>
              </div>
              <OpenThreadButton
                environmentAvailable={item.connected}
                item={item}
                onOpen={onOpenThread}
              />
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export async function refreshHumanInboxes(environmentId?: EnvironmentId, force = false) {
  const options = { force, ...(environmentId === undefined ? {} : { environmentId }) };
  const results = await Promise.all([
    refreshJ5Sources(openInboxSourcesAtom, openInboxQueryAtom, options),
    refreshJ5Sources(answeredInboxSourcesAtom, answeredInboxQueryAtom, options),
  ]);
  const failed = results.flat().find((result) => result._tag === "Failure");
  if (failed?._tag === "Failure") throw Cause.squash(failed.cause);
}

const useInboxRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(openInboxSourcesAtom, openInboxQueryAtom);
}, 7_500);

export function HumanInboxPage() {
  const navigate = useNavigate();
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const items = useMemo(() => mergeHumanInboxSources(openSources), [openSources]);
  const answeredItems = useMemo(() => mergeHumanInboxSources(answeredSources), [answeredSources]);
  const showEnvironment = spansMultipleEnvironments([...items, ...answeredItems]);
  const senderLabels = useScopedParticipantLabels(
    [...items, ...answeredItems].map((item) => ({
      environmentId: item.environmentId,
      participantId: item.senderId,
      connected: item.connected,
    })),
  );
  // The title the read carries stands in until the client's own project resolves.
  const projectOf = useLogicalProjects();
  const projectNameOf = useCallback(
    (item: HumanInboxItem) =>
      projectOf(item.environmentId, item.projectId)?.displayName ?? item.projectTitle,
    [projectOf],
  );
  const [answers, setAnswers] = useState<HumanInboxAnswers>({});
  const [pendingExchangeId, setPendingExchangeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answerAttempts = useRef(new Map<string, HumanInboxAnswerAttempt>());
  useInboxRefresh();
  const crewSources = useAtomValue(crewProposalSourcesAtom);
  const proposals = useMemo(
    () => inboxCrewRequests(mergeCrewProposalSources(crewSources)),
    [crewSources],
  );
  const [resolvingProposalId, setResolvingProposalId] = useState<string | null>(null);
  useCrewProposalsRefresh();
  const runtimeRequests = useCrewRuntimeRequests();
  const previousOpenItems = useRef(new Map<EnvironmentId, ReadonlySet<string>>());
  useEffect(() => {
    const next = new Map<EnvironmentId, ReadonlySet<string>>();
    for (const source of openSources.sources) {
      if (source.data === null) continue;
      const keys = new Set(
        source.data.items.map((item) =>
          scopedInboxItemKey({ ...item, environmentId: source.environmentId }),
        ),
      );
      const previous = previousOpenItems.current.get(source.environmentId);
      if (
        source.status === "ready" &&
        previous !== undefined &&
        [...previous].some((key) => !keys.has(key))
      ) {
        void refreshJ5Sources(answeredInboxSourcesAtom, answeredInboxQueryAtom, {
          environmentId: source.environmentId,
        });
      }
      next.set(source.environmentId, keys);
    }
    previousOpenItems.current = next;
  }, [openSources]);
  const loading =
    !openSources.isReady || openSources.sources.some((source) => source.status === "loading");
  const refreshing = [...openSources.sources, ...answeredSources.sources].some(
    (source) => source.refreshing,
  );
  const complete =
    openSources.isReady &&
    openSources.sources.some((source) => source.status === "ready") &&
    openSources.sources.every(
      (source) => source.status === "ready" || source.status === "unsupported",
    );
  const notices = [
    ...new Set(
      [...openSources.sources, ...answeredSources.sources].flatMap((source) => {
        const notice = j5SourceNotice(source);
        return notice === null ? [] : [notice];
      }),
    ),
  ];
  const refresh = useCallback(async (environmentId?: EnvironmentId) => {
    await refreshHumanInboxes(environmentId, true);
  }, []);

  // Removing a connection or changing its person must also discard that inbox's unsent replies.
  const personScopes = JSON.stringify(
    openSources.sources.map((source) => [source.environmentId, source.data?.personId ?? null]),
  );
  useEffect(() => {
    const people = new Map(JSON.parse(personScopes) as Array<[string, string | null]>);
    const keep = (key: string) => {
      const [environmentId, personId] = JSON.parse(key) as [string, string];
      return (
        people.has(environmentId) &&
        (people.get(environmentId) === null || people.get(environmentId) === personId)
      );
    };
    setAnswers((current) => {
      const entries = Object.entries(current).filter(([key]) => keep(key));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    for (const key of answerAttempts.current.keys())
      if (!keep(key)) answerAttempts.current.delete(key);
  }, [personScopes]);

  const answer = async (item: HumanInboxItem) => {
    const itemKey = scopedInboxItemKey(item);
    const message = answers[itemKey] ?? "";
    if (message.length === 0 || !item.sourceReady) return;
    await submitHumanInboxAnswer({
      item,
      message,
      attempts: answerAttempts.current,
      randomUUID,
      send: answerHumanExchange,
      refresh,
      notifyChanged: notifyHumanInboxChanged,
      onAccepted: () =>
        setAnswers((current) => {
          const next = { ...current };
          delete next[itemKey];
          return next;
        }),
      setPendingExchangeId,
      setError,
    });
  };

  const resolveProposal = async (
    proposal: ScopedCrewProposal,
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
    approvalToken?: string,
  ) => {
    setResolvingProposalId(proposal.id);
    setError(null);
    try {
      if (decision === "approve" && approvalToken === undefined)
        throw new Error("Refresh the runtime preview before approving.");
      await resolveCrewProposal(
        proposal.environmentId,
        decision === "approve"
          ? { proposalId: proposal.id, decision, seats, approvalToken: approvalToken! }
          : { proposalId: proposal.id, decision },
      );
      notifyHumanInboxChanged(proposal.environmentId);
      await refreshCrewProposals(proposal.environmentId).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resolve the crew request.");
    } finally {
      setResolvingProposalId(null);
    }
  };
  const openCaptain = useCallback(
    (proposal: ScopedCrewProposal) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(proposal.environmentId, ThreadId.make(proposal.captainThreadId)),
        ),
      });
    },
    [navigate],
  );

  const openCrewThread = useCallback(
    (request: ScopedCrewRuntimeRequest) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(request.environmentId, request.threadId)),
      });
    },
    [navigate],
  );

  const openThread = useCallback(
    (item: HumanInboxItem) => {
      if (!item.connected || item.senderThreadId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(item.environmentId, ThreadId.make(item.senderThreadId)),
        ),
      });
    },
    [navigate],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Inbox breadcrumb">
            <WorkspaceBreadcrumbItem current>Inbox</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
              <div>
                <h1 className="text-balance text-2xl font-semibold tracking-tight">Inbox</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loading && items.length === 0
                    ? "Loading questions waiting on you…"
                    : `${items.length} ${complete ? "open" : "loaded"} ${items.length === 1 ? "question" : "questions"}${
                        proposals.length === 0
                          ? ""
                          : ` · ${proposals.length} crew ${proposals.length === 1 ? "request" : "requests"}`
                      }${
                        runtimeRequests.length === 0
                          ? ""
                          : ` · ${runtimeRequests.length} crew agent ${runtimeRequests.length === 1 ? "request" : "requests"}`
                      }`}
                </p>
              </div>
              <Button
                aria-label="Refresh inbox"
                disabled={refreshing}
                onClick={() => void refresh().catch(() => undefined)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon aria-hidden className="size-4" />
                Refresh
              </Button>
            </div>

            {notices.length > 0 ? (
              <ul aria-live="polite" className="mt-4 space-y-1 text-sm text-muted-foreground">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            ) : null}

            {error ? (
              <div
                aria-live="polite"
                className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/8 px-4 py-3 text-sm text-destructive-foreground"
              >
                <span>{error}</span>
                <Button
                  onClick={() => void refresh().catch(() => undefined)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : null}

            {proposals.length > 0 ? (
              <section aria-label="Crew requests" className="mt-6">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Crew requests
                </h2>
                <ul className="space-y-4">
                  {proposals.map((proposal) => (
                    <CrewProposalCard
                      key={`${proposal.environmentId}:${proposal.id}`}
                      proposal={proposal}
                      environmentId={proposal.environmentId}
                      busy={resolvingProposalId === proposal.id}
                      onResolve={(decision, seats, approvalToken) =>
                        void resolveProposal(proposal, decision, seats, approvalToken)
                      }
                      onOpenCaptain={() => openCaptain(proposal)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            <CrewRuntimeRequestsSection requests={runtimeRequests} onOpenThread={openCrewThread} />

            {complete &&
            !loading &&
            error === null &&
            items.length === 0 &&
            proposals.length === 0 &&
            runtimeRequests.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center px-6 py-12 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-success/10 text-success">
                  <InboxIcon aria-hidden className="size-5" />
                </span>
                <h2 className="mt-4 text-base font-medium">Nothing is waiting on you</h2>
                <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  New questions from agents will arrive here in urgency order.
                </p>
              </div>
            ) : (
              <ol className="divide-y divide-border/70">
                {items.map((item) => (
                  <OpenInboxItem
                    answer={answer}
                    answerText={answers[scopedInboxItemKey(item)] ?? ""}
                    item={item}
                    key={scopedInboxItemKey(item)}
                    onOpenThread={openThread}
                    pendingExchangeId={pendingExchangeId}
                    senderLabels={senderLabels}
                    projectNameOf={projectNameOf}
                    setAnswers={setAnswers}
                    showEnvironment={showEnvironment}
                  />
                ))}
              </ol>
            )}

            <AnsweredShelf
              items={answeredItems}
              onOpenThread={openThread}
              senderLabels={senderLabels}
              projectNameOf={projectNameOf}
              showEnvironment={showEnvironment}
            />
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
