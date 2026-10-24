import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProjectId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { scopedInboxItemKey, type ScopedHumanInboxItem } from "@t3tools/contracts/j5";
import { useAtomValue } from "@effect/atom-react";
import {
  compareInboxItems,
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
import { useEffect, useRef, useState } from "react";

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
import { RelativeTime } from "../../components/RelativeTime";
import { RelativeAge } from "../RelativeAge";
import { answerHumanExchange } from "./humanInboxClient";
import { useScopedParticipantLabels } from "./ParticipantIdentitiesClient";
import { presentParticipantIdentity } from "./ParticipantIdentity";
import { CrewProposalCard } from "../crew/CrewProposalCard";
import { CrewRuntimeRequestsSection } from "../crew/CrewRuntimeRequestsSection";
import type { ScopedCrewRuntimeRequest } from "../crew/crewRuntimeRequests.logic";
import {
  refreshCrewRuntimeRequests,
  useCrewRuntimeRequests,
  useNativeQuestionInbox,
} from "../crew/crewRuntimeRequestsClient";
import { NativeQuestionInboxSection } from "./NativeQuestionInboxSection";
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
  crewRuntimeRequestSourcesAtom,
  j5Environment,
  openInboxQueryAtom,
  openInboxSourcesAtom,
  refreshJ5Sources,
} from "../state";
import { useLogicalProjects } from "../logicalProjects";
import { createVisibleRefreshHook } from "../useVisibleRefresh";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";
import { answeredByLine, closedLine, nextKeptItems } from "./inboxKept.logic";
import { useConnectionAccess } from "../sharing/access";

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

/** The reader's own name on an item's server, so "Priya answered" can read "You answered". */
function useOwnName(environmentId: EnvironmentId): string | null {
  const access = useConnectionAccess(environmentId);
  return access?.kind === "person" ? access.name : null;
}

/** The mark on an ask addressed to everyone who can write to the asking agent's thread (AC15). */
function ForEveryoneMark({ item }: { readonly item: HumanInboxItem }) {
  if (item.forEveryone !== true) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="shrink-0">for everyone here</span>
    </>
  );
}

const urgencyPresentation = {
  blocking: { label: "Blocking", variant: "destructive" as const },
  soon: { label: "Soon", variant: "warning" as const },
  fyi: { label: "FYI", variant: "secondary" as const },
};

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
      // The server answers as the connection's own person; the request names no one.
      await input.send(input.item.environmentId, {
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
  closed,
}: {
  readonly item: HumanInboxItem;
  /**
   * The item closed while the person had typed into it, and stays with their words (AC17): who
   * answered, or that it is no longer open. `undefined` for an open item.
   */
  readonly closed?:
    | {
        readonly answered: { readonly answeredBy: string | null | undefined } | null;
        readonly answeredReadSinceClose: boolean;
      }
    | undefined;
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
  const mayAnswer = useAtomValue(
    j5Environment.answerHumanExchange.permissionAtom(item.environmentId),
  );
  const canAnswer = item.sourceReady && mayAnswer;
  const ownName = useOwnName(item.environmentId);
  const closedText = closed === undefined ? null : closedLine({ ...closed, ownName });
  return (
    <li className="border-b border-border/70 last:border-b-0">
      <details className="group/details">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-1 py-4 outline-hidden marker:hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 [&::-webkit-details-marker]:hidden">
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
              <ForEveryoneMark item={item} />
              {showEnvironment || !item.connected ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">
                    {showEnvironment ? item.environmentLabel : ""}
                    {item.connected ? "" : showEnvironment ? " (offline)" : "offline"}
                  </span>
                </>
              ) : null}
              {closed === undefined ? (
                <>
                  <span aria-hidden>·</span>
                  <time className="tabular-nums" dateTime={item.openedAt}>
                    open <RelativeAge timestamp={item.openedAt} fallback="" />
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
              {closedText !== null ? (
                <p className="text-sm text-muted-foreground" data-j5-inbox="closed">
                  {closedText}
                </p>
              ) : (
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
              )}
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
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-sm font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-4 transition-transform duration-150 group-open/shelf:rotate-90"
        />
        Answered
        <span className="tabular-nums text-muted-foreground/70">{items.length}</span>
      </summary>
      <ol className="mt-1 divide-y divide-border/60 ps-6">
        {items.map((item) => {
          return (
            <li className="flex min-w-0 items-start gap-3 py-3" key={scopedInboxItemKey(item)}>
              <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-foreground/80">{item.intent}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  <SenderName item={item} senderLabels={senderLabels} /> · {projectNameOf(item)}
                  {showEnvironment ? ` · ${item.environmentLabel}` : ""}
                  {item.forEveryone === true ? " · for everyone here" : ""}
                  {" · answered"}
                  {item.terminalAt ? (
                    <>
                      {" "}
                      <RelativeTime timestamp={item.terminalAt} />
                    </>
                  ) : null}
                  <AnsweredBy item={item} />
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

/** " · Priya answered", for an ask whose answerer the server names (AC16). */
function AnsweredBy({ item }: { readonly item: HumanInboxItem }) {
  const line = answeredByLine(item.answeredBy, useOwnName(item.environmentId));
  return line === null ? null : <> · {line}</>;
}

export async function refreshHumanInboxes(environmentId?: EnvironmentId, force = false) {
  const options = { force, ...(environmentId === undefined ? {} : { environmentId }) };
  const results = await Promise.all([
    refreshJ5Sources(openInboxSourcesAtom, openInboxQueryAtom, options),
    refreshJ5Sources(answeredInboxSourcesAtom, answeredInboxQueryAtom, options),
    refreshCrewRuntimeRequests(environmentId),
  ]);
  const failed = results.flat().find((result) => result._tag === "Failure");
  if (failed?._tag === "Failure") throw Cause.squash(failed.cause);
}

/** A draft answer survives only while its environment still reads the inbox as the same person. */
function keepForPersonScopes(personScopes: string) {
  const people = new Map(JSON.parse(personScopes) as Array<[string, string | null]>);
  return (key: string) => {
    const [environmentId, personId] = JSON.parse(key) as [string, string];
    return (
      people.has(environmentId) &&
      (people.get(environmentId) === null || people.get(environmentId) === personId)
    );
  };
}

/** Resolves outside the component: the React Compiler cannot compile `throw` inside `try`. */
async function resolveInboxProposal(
  proposal: ScopedCrewProposal,
  decision: "approve" | "decline",
  seats: ReadonlyArray<CrewProposalSeat>,
  approvalToken: string | undefined,
): Promise<string | null> {
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
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "Could not resolve the crew request.";
  }
}

const useInboxRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(openInboxSourcesAtom, openInboxQueryAtom);
});

export function HumanInboxPage() {
  const navigate = useNavigate();
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const items = mergeHumanInboxSources(openSources);
  const answeredItems = mergeHumanInboxSources(answeredSources);
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
  const projectNameOf = (item: HumanInboxItem) =>
    projectOf(item.environmentId, item.projectId)?.displayName ?? item.projectTitle;
  const [answers, setAnswers] = useState<HumanInboxAnswers>({});
  // Removing a connection or changing its person must also discard that inbox's unsent replies.
  const personScopes = JSON.stringify(
    openSources.sources.map((source) => [source.environmentId, source.data?.personId ?? null]),
  );
  const [answersPersonScopes, setAnswersPersonScopes] = useState(personScopes);
  if (answersPersonScopes !== personScopes) {
    setAnswersPersonScopes(personScopes);
    const keep = keepForPersonScopes(personScopes);
    const entries = Object.entries(answers).filter(([key]) => keep(key));
    if (entries.length !== Object.keys(answers).length) setAnswers(Object.fromEntries(entries));
  }
  const [pendingExchangeId, setPendingExchangeId] = useState<string | null>(null);
  // An item that closed while the person was answering it stays in place with their words. It is
  // kept in the render it closes in, so its open row is never unmounted and drawn again closed;
  // `closedWith` is the answered list as it was then, to tell a later read of it.
  const [retention, setRetention] = useState(() => ({
    openSources,
    items,
    answers,
    kept: new Map() as ReadonlyMap<string, HumanInboxItem>,
    closedWith: new Map() as ReadonlyMap<string, typeof answeredSources>,
  }));
  let { kept, closedWith } = retention;
  if (retention.openSources !== openSources || retention.answers !== answers) {
    kept = nextKeptItems({
      previous: retention.items,
      current: items,
      kept: retention.kept,
      answers,
      keyOf: scopedInboxItemKey,
    });
    closedWith = new Map(
      [...kept.keys()].map((key) => [key, retention.closedWith.get(key) ?? answeredSources]),
    );
    setRetention({ openSources, items, answers, kept, closedWith });
  }
  const shownItems =
    kept.size === 0 ? items : [...items, ...kept.values()].toSorted(compareInboxItems);
  const answeredByKey = new Map(answeredItems.map((item) => [scopedInboxItemKey(item), item]));
  const closedOf = (item: HumanInboxItem) => {
    const key = scopedInboxItemKey(item);
    if (!kept.has(key)) return undefined;
    const answered = answeredByKey.get(key);
    const source = answeredSources.sources.find(
      (candidate) => candidate.environmentId === item.environmentId,
    );
    return {
      answered: answered === undefined ? null : { answeredBy: answered.answeredBy },
      answeredReadSinceClose:
        closedWith.get(key) !== answeredSources && source?.status === "ready" && !source.refreshing,
    };
  };
  const [error, setError] = useState<string | null>(null);
  const answerAttempts = useRef(new Map<string, HumanInboxAnswerAttempt>());
  useInboxRefresh();
  const crewSources = useAtomValue(crewProposalSourcesAtom);
  const proposals = inboxCrewRequests(mergeCrewProposalSources(crewSources));
  const [resolvingProposalId, setResolvingProposalId] = useState<string | null>(null);
  useCrewProposalsRefresh();
  const runtimeRequests = useCrewRuntimeRequests();
  const runtimeSources = useAtomValue(crewRuntimeRequestSourcesAtom);
  const nativeQuestions = useNativeQuestionInbox();
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
    runtimeSources.isReady &&
    runtimeSources.sources.every(
      (source) => source.status === "ready" || source.status === "unsupported",
    ) &&
    openSources.sources.some((source) => source.status === "ready") &&
    openSources.sources.every(
      (source) => source.status === "ready" || source.status === "unsupported",
    );
  const notices = [
    ...new Set(
      [...openSources.sources, ...answeredSources.sources, ...runtimeSources.sources].flatMap(
        (source) => {
          const notice = j5SourceNotice(source);
          return notice === null ? [] : [notice];
        },
      ),
    ),
  ];
  const refresh = async (environmentId?: EnvironmentId) => {
    await refreshHumanInboxes(environmentId, true);
  };

  useEffect(() => {
    const keep = keepForPersonScopes(personScopes);
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
    const failure = await resolveInboxProposal(proposal, decision, seats, approvalToken);
    if (failure !== null) setError(failure);
    setResolvingProposalId(null);
  };
  const openCaptain = (proposal: ScopedCrewProposal) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(proposal.environmentId, ThreadId.make(proposal.captainThreadId)),
      ),
    });
  };

  const openCrewThread = (
    request: Pick<ScopedCrewRuntimeRequest, "environmentId" | "threadId">,
  ) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(request.environmentId, request.threadId)),
    });
  };

  const openThread = (item: HumanInboxItem) => {
    if (!item.connected || item.senderThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(item.environmentId, ThreadId.make(item.senderThreadId)),
      ),
    });
  };

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
                        runtimeRequests.length + nativeQuestions.length === 0
                          ? ""
                          : ` · ${runtimeRequests.length + nativeQuestions.length} agent ${runtimeRequests.length + nativeQuestions.length === 1 ? "request" : "requests"}`
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
            <NativeQuestionInboxSection questions={nativeQuestions} onOpenThread={openCrewThread} />

            {complete &&
            !loading &&
            error === null &&
            shownItems.length === 0 &&
            proposals.length === 0 &&
            runtimeRequests.length === 0 &&
            nativeQuestions.length === 0 ? (
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
                {shownItems.map((item) => (
                  <OpenInboxItem
                    closed={closedOf(item)}
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
