import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useCrewMembership } from "../crew/CrewMembershipsClient";
import { j5Environment, openInboxQueryAtom } from "../state";
import {
  adjudicationAsks,
  commandsACrew,
  hasMoreThanExcerpt,
  isAskAlreadyClosed,
  pickShownAsk,
} from "./adjudicationDock.logic";
import { answerHumanExchange, type HumanInboxItem } from "./humanInboxClient";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";

const urgencyBadge = {
  blocking: { label: "Blocking", variant: "destructive" },
  soon: { label: "Soon", variant: "warning" },
  fyi: { label: "FYI", variant: "secondary" },
} as const;

/**
 * A Captain's open asks to the person, pinned above its composer the way a Crew proposal is.
 * They are the Inbox's own asks, read from the same list and answered through the same command,
 * so answering here or there closes the one exchange and the other view follows the read-change
 * feed (Crews: adjudication request).
 */
export function AdjudicationDock(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
}) {
  const { environmentId, threadId } = props;
  const captain = commandsACrew(
    useCrewMembership(
      environmentId === undefined || threadId == null
        ? undefined
        : scopeThreadRef(environmentId, threadId),
    ),
  );
  const query = useEnvironmentQuery(
    captain && environmentId !== undefined ? openInboxQueryAtom(environmentId) : null,
  );
  const mayAnswer = useAtomValue(
    j5Environment.answerHumanExchange.permissionAtom(environmentId ?? null),
  );
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<ReadonlyArray<HumanInboxItem>>([]);
  const attempt = useRef<{ exchangeId: string; message: string; clientRequestId: string } | null>(
    null,
  );

  const asks = adjudicationAsks({
    items: query.data?.items ?? [],
    refused,
    threadId,
    hasWords: (exchangeId) => (answers[exchangeId] ?? "") !== "",
  });
  const view = pickShownAsk(asks, picked);
  if (!captain || !mayAnswer || environmentId === undefined || view === null) return null;
  const { shown, others } = view;
  const isOpen = (query.data?.items ?? []).some((item) => item.exchangeId === shown.exchangeId);
  const message = answers[shown.exchangeId] ?? "";
  const urgency = urgencyBadge[shown.urgency];
  const openFor = formatElapsedDurationLabel(shown.openedAt);
  const threadRef = threadId == null ? undefined : scopeThreadRef(environmentId, threadId);

  const answer = async () => {
    if (message === "") return;
    // A retry of the same words reuses its request id, so a lost reply cannot answer twice.
    const request =
      attempt.current?.exchangeId === shown.exchangeId && attempt.current.message === message
        ? attempt.current
        : { exchangeId: shown.exchangeId, message, clientRequestId: randomUUID() };
    attempt.current = request;
    setPending(true);
    setError(null);
    try {
      await answerHumanExchange(environmentId, request);
      attempt.current = null;
      notifyHumanInboxChanged(environmentId);
      setAnswers((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== shown.exchangeId)),
      );
      query.refresh();
    } catch (cause) {
      if (isAskAlreadyClosed(cause)) {
        setRefused((current) => [...current, shown]);
        query.refresh();
      } else {
        setError(cause instanceof Error ? cause.message : "Could not deliver the answer.");
      }
    }
    setPending(false);
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-testid="adjudication-dock">
        <div className="flex flex-col gap-2 px-2 py-1">
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>Question for you</span>
            {openFor ? <span>· open {openFor}</span> : null}
            <Badge variant={urgency.variant}>
              <span className="uppercase tracking-wide">{urgency.label}</span>
            </Badge>
          </div>
          <h3 className="text-sm font-semibold leading-snug text-foreground">{shown.intent}</h3>
          <div className={expanded.has(shown.exchangeId) ? "text-sm" : "line-clamp-3 text-sm"}>
            <ChatMarkdown
              cwd={undefined}
              environmentId={environmentId}
              lineBreaks={shouldPreserveAssistantLineBreaks(shown.message)}
              text={shown.message}
              threadRef={threadRef}
            />
          </div>
          {hasMoreThanExcerpt(shown.message) ? (
            <Button
              className="w-fit"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (!next.delete(shown.exchangeId)) next.add(shown.exchangeId);
                  return next;
                })
              }
              size="xs"
              type="button"
              variant="ghost"
            >
              {expanded.has(shown.exchangeId) ? "Show less" : "Show full question"}
            </Button>
          ) : null}
          <Textarea
            aria-label={`Answer ${shown.intent}`}
            className="min-h-9"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setAnswers((current) => ({ ...current, [shown.exchangeId]: value }));
            }}
            placeholder="Type the answer exactly as it should be delivered"
            value={message}
          />
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {isOpen ? (
              <Button
                disabled={pending || message === ""}
                onClick={() => void answer()}
                size="sm"
                type="button"
              >
                {pending ? "Delivering…" : "Answer"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground" data-j5-adjudication="closed">
                Already answered
              </p>
            )}
          </div>
          {others.length > 0 ? (
            <Button
              className="w-full justify-start"
              onClick={() => setPicked(others[0]!.exchangeId)}
              type="button"
              variant="outline"
            >
              <span className="shrink-0">
                {others.length} more {others.length === 1 ? "question" : "questions"}
              </span>
              <span className="min-w-0 flex-1 truncate text-start text-muted-foreground">
                · {others[0]!.intent}
              </span>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
            </Button>
          ) : null}
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
