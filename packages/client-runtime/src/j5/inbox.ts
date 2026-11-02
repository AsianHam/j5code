import type { EnvironmentId } from "@t3tools/contracts";
import {
  type ConnectionAccess,
  type HumanInboxResponse,
  type ScopedHumanInboxItem,
  scopedInboxItemKey,
} from "@t3tools/contracts/j5";

import type { J5ReadSource, J5ReadSources } from "./readSources.ts";

export type PresentedHumanInboxItem = ScopedHumanInboxItem & {
  readonly environmentLabel: string;
  readonly connected: boolean;
  /**
   * The item's server is connected and its inbox read is current. Whether this session may
   * answer is the answer command's `permissionAtom`.
   */
  readonly sourceReady: boolean;
};

const urgencyOrder = { blocking: 0, soon: 1, fyi: 2 } as const;

/** The inbox's order: urgency first, then age, oldest first within an urgency (Inbox AC6). */
export const compareInboxItems = (left: ScopedHumanInboxItem, right: ScopedHumanInboxItem) =>
  urgencyOrder[left.urgency] - urgencyOrder[right.urgency] ||
  left.openedAt.localeCompare(right.openedAt) ||
  left.environmentId.localeCompare(right.environmentId) ||
  left.exchangeId.localeCompare(right.exchangeId);

export function mergeHumanInboxSources(input: J5ReadSources<HumanInboxResponse>) {
  const items: Array<PresentedHumanInboxItem> = input.sources.flatMap((source) =>
    (source.data?.items ?? []).map((item) => ({
      ...item,
      environmentId: source.environmentId,
      environmentLabel: source.environmentLabel,
      connected: source.connected,
      sourceReady: source.status === "ready",
    })),
  );
  items.sort(compareInboxItems);
  return items;
}

export function mergeOpenInboxCounts(
  input: J5ReadSources<{ readonly personId: string; readonly count: number }>,
) {
  const known = input.sources.filter((source) => source.data !== null);
  return {
    count: known.length === 0 ? null : known.reduce((sum, source) => sum + source.data!.count, 0),
    incomplete:
      !input.isReady ||
      input.sources.some((source) => source.status !== "ready" && source.status !== "unsupported"),
  };
}

/**
 * What an inbox bell says: its badge, if any, and its spoken label. A count some server could not
 * refresh is marked: `3*` when it is a last-known count, `?` when nothing is known.
 */
export function inboxBellPresentation(input: {
  readonly count: number | null;
  readonly incomplete: boolean;
}): { readonly badge: string | null; readonly label: string } {
  const { count, incomplete } = input;
  const badge = incomplete
    ? count !== null && count > 0
      ? `${count}*`
      : "?"
    : count !== null && count > 0
      ? String(count)
      : null;
  const label = `${count === null ? "Open inbox" : `Open inbox, ${incomplete ? "last known " : ""}${count} open`}${incomplete ? "; some environments could not be refreshed" : ""}`;
  return { badge, label };
}

export function j5SourceNotice(source: J5ReadSource<unknown>): string | null {
  switch (source.status) {
    case "ready":
      return null;
    case "loading":
      return `${source.environmentLabel}: loading…`;
    case "offline":
      return `${source.environmentLabel}: offline${source.data === null ? "" : " (showing saved results)"}.`;
    case "unsupported":
      return source.guest === true
        ? `${source.environmentLabel}: not shared with you.`
        : `${source.environmentLabel}: this server does not provide this J5 feature.`;
    case "error":
      return `${source.environmentLabel}: ${source.error ?? "could not refresh"}${source.data === null ? "" : " (showing saved results)."}`;
  }
}

/**
 * Whether a connection writes to nothing on its server, so has no inbox: an unknown device, or a
 * person who is a Viewer everywhere. Their asks are answered by someone who can write (Inbox AC14).
 */
export const writesNowhere = (access: ConnectionAccess | null): boolean =>
  access?.kind === "unknown" ||
  (access?.kind === "person" && access.levels.every((held) => held.level === "viewer"));

/**
 * Items with a typed answer when they closed stay, with the words, until the person clears them or
 * leaves the page (Inbox AC17). An answer this client is sending keeps its words until the server
 * confirms it, which clears them; if someone else's answer won, the words stay, with who answered.
 */
export function nextKeptItems<Item>(input: {
  readonly previous: ReadonlyArray<Item>;
  readonly current: ReadonlyArray<Item>;
  readonly kept: ReadonlyMap<string, Item>;
  readonly answers: Readonly<Record<string, string>>;
  readonly keyOf: (item: Item) => string;
}): ReadonlyMap<string, Item> {
  const open = new Set(input.current.map(input.keyOf));
  const typed = (key: string) => (input.answers[key] ?? "").trim() !== "";
  const next = new Map<string, Item>();
  for (const [key, item] of input.kept) {
    if (!open.has(key) && typed(key)) next.set(key, item);
  }
  for (const item of input.previous) {
    const key = input.keyOf(item);
    if (!open.has(key) && typed(key)) next.set(key, item);
  }
  return next.size === input.kept.size && [...next.keys()].every((key) => input.kept.has(key))
    ? input.kept
    : next;
}

/**
 * Who answered an ask, as the Replied shelf and a kept item say it: "You answered", "Priya
 * answered" (Inbox AC16). `null` when the server names no one.
 */
export function answeredByLine(
  answeredBy: string | null | undefined,
  ownName: string | null,
): string | null {
  if (answeredBy === null || answeredBy === undefined) return null;
  return ownName !== null && answeredBy === ownName ? "You answered" : `${answeredBy} answered`;
}

/**
 * What a kept item says in place of its Answer button: who answered, once the answered asks list
 * it; that the agent withdrew it, once a read of them since it closed does not; and, until then,
 * only that it is no longer open.
 */
export function closedLine(input: {
  /** The ask as the answered list holds it, or `null` when that list does not hold it. */
  readonly answered: { readonly answeredBy: string | null | undefined } | null;
  readonly answeredReadSinceClose: boolean;
  readonly ownName: string | null;
}): string {
  if (input.answered !== null) {
    return answeredByLine(input.answered.answeredBy, input.ownName) ?? "Answered";
  }
  return input.answeredReadSinceClose ? "The agent withdrew this" : "No longer open";
}

/** One answer being delivered: a retry with the same words reuses its `clientRequestId`. */
export interface HumanInboxAnswerAttempt {
  readonly message: string;
  readonly clientRequestId: string;
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

/** A draft answer survives only while its environment still reads the inbox as the same person. */
export function keepForPersonScopes(personScopes: string) {
  const people = new Map(JSON.parse(personScopes) as Array<[string, string | null]>);
  return (key: string) => {
    const [environmentId, personId] = JSON.parse(key) as [string, string];
    return (
      people.has(environmentId) &&
      (people.get(environmentId) === null || people.get(environmentId) === personId)
    );
  };
}
