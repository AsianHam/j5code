import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { UserPlusIcon } from "lucide-react";
import { useMemo } from "react";

import { ThreadDetailsControl } from "../../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { PersonAvatar } from "./PersonAvatar";
import { placeLinks } from "./people.logic";
import { useAccessRows } from "./scopeAccess";
import { AccessRowLine, LinkLine } from "./ShareDialog";
import { openSharingDialog } from "./sharingDialogs";
import { linksQuery, sharingManage } from "./sharingManage";

const count = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * The pill in a thread's header once more than one person reaches the thread: who, at a glance.
 * It opens the Share dialog for an Owner whose device manages access, and is information for
 * anyone else (design §2).
 */
export function ThreadPeopleChip({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scope = useMemo(() => ({ kind: "thread" as const, threadId }), [threadId]);
  const { rows } = useAccessRows(environmentId, scope);
  const canManage = useAtomValue(sharingManage.createLink.permissionAtom(environmentId));
  if (rows === null || rows.length < 2) return null;
  const label = count(rows.length);
  const content = (
    <>
      <span className="flex -space-x-1.5 *:ring-2 *:ring-background">
        {rows.slice(0, 3).map((row, index) => (
          // Someone who is not an Owner is told no ids, and two people may share initials.
          // oxlint-disable-next-line react/no-array-index-key -- the list is replaced whole on every change
          <PersonAvatar key={index} name={row.name} size="xs" />
        ))}
      </span>
      {label}
    </>
  );
  const className =
    "ml-auto flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border pr-2 pl-1 text-xs text-foreground";
  return canManage ? (
    <button
      type="button"
      className={`${className} cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
      aria-label={`${label} reach this thread. Share thread`}
      onClick={() => openSharingDialog({ kind: "share", environmentId, scope })}
    >
      {content}
    </button>
  ) : (
    <span className={className} aria-label={`${label} reach this thread`}>
      {content}
    </span>
  );
}

/**
 * The People section of a thread's details panel: the Share dialog's list, in place. Everyone who
 * reaches the thread sees the names and levels (AC26); an Owner whose device manages access also
 * changes levels here and opens the dialog from its heading.
 */
export function ThreadPeopleSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scope = useMemo(() => ({ kind: "thread" as const, threadId }), [threadId]);
  const { rows, error } = useAccessRows(environmentId, scope);
  const canManage = useAtomValue(sharingManage.createLink.permissionAtom(environmentId));
  const links = useEnvironmentQuery(canManage ? linksQuery(environmentId) : null);
  const nowMs = Date.parse(useNowMinute());
  // The same places for links as the Share dialog's list.
  const placed = placeLinks({
    links: links.data?.links ?? [],
    scope,
    listed: new Set((rows ?? []).flatMap((row) => (row.personId === null ? [] : [row.personId]))),
    nowMs,
  });
  return (
    <ThreadDetailsSection
      headingId="j5-thread-people-heading"
      title="People"
      actions={
        canManage ? (
          // Upstream's details sections head with an icon action and its tooltip (Automations).
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Share thread"
                  onClick={() => openSharingDialog({ kind: "share", environmentId, scope })}
                >
                  <UserPlusIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Share thread</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {rows === null ? (
        <p className="flex min-h-8 items-center px-1.5 text-xs text-muted-foreground">
          {error ?? "Reading who reaches this thread…"}
        </p>
      ) : (
        <div className="flex flex-col">
          {rows.map((row, index) => (
            <AccessRowLine
              // Someone who is not an Owner is told no ids.
              key={row.personId ?? index}
              environmentId={environmentId}
              scope={scope}
              row={row}
              canManage={canManage}
              unusedLinks={
                row.personId === null ? [] : (placed.underPerson.get(row.personId) ?? [])
              }
              nowMs={nowMs}
            />
          ))}
          {placed.after.map((link) => (
            <LinkLine
              key={link.linkId}
              environmentId={environmentId}
              link={link}
              canManage={canManage}
              nowMs={nowMs}
              indent={false}
              label={link.use === "one" ? `${link.personName ?? "One person"} · ` : null}
            />
          ))}
        </div>
      )}
    </ThreadDetailsSection>
  );
}
