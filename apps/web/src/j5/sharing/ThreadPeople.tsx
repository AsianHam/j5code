import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  SharingGrantLevel,
  SharingThreadGuest,
  SharingThreadPeople,
} from "@t3tools/contracts/j5";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  Link2Icon,
  LogOutIcon,
  SettingsIcon,
  UserPlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useProjects, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildPhysicalToLogicalProjectKeyMap } from "../../sidebarProjectGrouping";
import { ConfirmNameTag } from "./ConfirmNameTag";
import { j5Sharing } from "./guestAccess";
import { initialsOf, levelLabel, lifetimeLeft } from "./shareLink.logic";
import { openSharingDialog } from "./sharingDialogs";
import { refreshSharing, refusalMessage, sharingManage } from "./sharingManage";
import {
  chipLabel,
  guestName,
  memberName,
  othersLabel,
  removeFromThreadWarning,
  threadPeopleView,
  type ThreadPeopleView,
} from "./threadPeople.logic";

function Avatar({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-4xs font-semibold text-muted-foreground ring-2 ring-background"
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Who reaches a thread, as the server tells anyone who can reach it: a member, or a guest it was
 * shared with. The server counts each time its answer changes, and the answer is asked again then.
 */
function useThreadPeople(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): SharingThreadPeople | null {
  const target = useMemo(() => ({ environmentId, input: { threadId } }), [environmentId, threadId]);
  const query = sharingManage.threadPeople(target);
  const people = useEnvironmentQuery(query);
  const revision = useEnvironmentQuery(sharingManage.threadPeopleChanges(target)).data?.revision;
  useEffect(() => {
    if (revision !== undefined && revision > 0) appAtomRegistry.refresh(query);
  }, [query, revision]);
  return people.data;
}

/**
 * The pill in a thread's header once the thread is shared: who it is shared with, at a glance. It
 * opens the Share dialog for a member who can manage access and is information for anyone else.
 * A thread only members reach shows nothing.
 */
export function ThreadPeopleChip({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const people = useThreadPeople(environmentId, threadId);
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const label = people === null ? null : chipLabel(people);
  if (people === null || label === null) return null;
  const shown = people.guests.slice(0, 3);
  const content = (
    <>
      <span className="flex -space-x-1.5">
        {shown.map((guest, index) => (
          // A guest asking is told no ids, and two people may share initials.
          // oxlint-disable-next-line react/no-array-index-key -- the list is replaced whole on every change
          <Avatar key={index} name={guestName(guest)} />
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
      className={`${className} cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring`}
      aria-label={`Shared with ${label}. Share thread`}
      onClick={() =>
        openSharingDialog({ kind: "share", environmentId, target: { kind: "thread", threadId } })
      }
    >
      {content}
    </button>
  ) : (
    <span className={className} aria-label={`Shared with ${label}`}>
      {content}
    </span>
  );
}

/** The link to a project's settings page, at its Sharing section. */
function useOpenProjectSharing(environmentId: EnvironmentId, threadId: ThreadId) {
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    projectTitle: project?.title ?? null,
    open: () => {
      if (project === null) return;
      const projectKey =
        buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }).get(
          derivePhysicalProjectKey(project),
        ) ?? deriveLogicalProjectKeyFromSettings(project, settings);
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey },
        hash: "project-sharing",
      });
    },
  };
}

/**
 * The People section of a thread's details panel: who holds a grant on the thread, the join link
 * when there is one, and one line for everyone who reaches it some other way. A member who
 * manages access changes it here; anyone else reads it. A guest sees members first, then everyone
 * with a grant, their own name marked, and the way to leave (Shared server AC25).
 */
export function ThreadPeopleSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const isGuest = useAtomValue(j5Sharing.isGuest(environmentId));
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const people = useThreadPeople(environmentId, threadId);
  const view = useMemo(() => (people === null ? null : threadPeopleView(people)), [people]);
  const nowMs = Date.parse(useNowMinute());
  const joinLink = people?.openLinks[0] ?? null;
  const joinLinkLeft =
    joinLink === null ? null : lifetimeLeft(joinLink.expiresAt.epochMilliseconds, nowMs);
  const projectSharing = useOpenProjectSharing(environmentId, threadId);
  const [othersOpen, setOthersOpen] = useState(false);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const threadTitle = thread?.title ?? "this thread";
  const share = () =>
    openSharingDialog({ kind: "share", environmentId, target: { kind: "thread", threadId } });
  const openJoinLink = () => openSharingDialog({ kind: "join-link", environmentId, threadId });
  const others = view === null ? null : othersLabel(view);

  return (
    <ThreadDetailsSection
      headingId="j5-thread-people-heading"
      title="People"
      actions={
        // Only a connection that can manage access gets controls; anyone else reads the section.
        isGuest || !canManage ? null : (
          <>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={!canManage}
              aria-label="Share thread"
              onClick={share}
            >
              <UserPlusIcon className="size-3.5" />
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-xs" variant="ghost-muted" aria-label="More sharing actions" />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                {joinLink === null ? (
                  <MenuItem disabled={!canManage} onClick={openJoinLink}>
                    Make a join link…
                  </MenuItem>
                ) : (
                  <MenuItem onClick={openJoinLink}>Join link…</MenuItem>
                )}
                {view !== null && view.throughProject.length > 0 ? (
                  <MenuItem onClick={projectSharing.open}>Manage project sharing</MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem onClick={() => void navigate({ to: "/settings/people" })}>
                  Open People settings
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        )
      }
    >
      {view === null ? (
        <p className={MUTED_ROW_CLASSNAME}>Reading who is on this thread…</p>
      ) : (
        <>
          {isGuest
            ? view.members.map((member, index) => (
                // A guest is told no ids.
                // oxlint-disable-next-line react/no-array-index-key -- the list is replaced whole on every change
                <div key={index} className={ROW_CLASSNAME}>
                  <Avatar name={memberName(member)} />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {memberName(member)}
                  </span>
                  <span className="text-muted-foreground">Member</span>
                </div>
              ))
            : null}
          {view.direct.map((guest, index) => (
            <GuestRow
              key={guest.personId ?? index}
              environmentId={environmentId}
              threadId={threadId}
              threadTitle={threadTitle}
              guest={guest}
              canManage={canManage}
            />
          ))}
          {!isGuest && view.direct.length === 0 && joinLink === null ? (
            <p className={MUTED_ROW_CLASSNAME}>Only members reach this thread.</p>
          ) : null}
          <div className="flex flex-col items-start">
            {joinLink !== null && joinLinkLeft !== null ? (
              <Button size="xs" variant="ghost-muted" onClick={openJoinLink}>
                <Link2Icon className="size-3" />
                Join link · {joinLinkLeft} left
              </Button>
            ) : null}
            {others === null ||
            (isGuest && view.throughProject.length + view.throughAncestor.length === 0) ? null : (
              <Button size="xs" variant="ghost-muted" onClick={() => setOthersOpen(true)}>
                {isGuest ? othersLabel({ ...view, members: [] }) : others}
                <ChevronRightIcon className="size-3" />
              </Button>
            )}
            {/* Leaving is of a grant: only a grant on this thread is left from the thread. */}
            {view.you !== null && view.you.grants.some((grant) => grant.via === "thread") ? (
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => openSharingDialog({ kind: "leave", environmentId, threadId })}
              >
                <LogOutIcon className="size-3" />
                Leave this thread
              </Button>
            ) : null}
          </div>
          <OthersDialog
            open={othersOpen}
            onClose={() => setOthersOpen(false)}
            view={isGuest ? { ...view, members: [] } : view}
            projectTitle={projectSharing.projectTitle}
            gears={!isGuest}
            onOpenPeople={() => void navigate({ to: "/settings/people" })}
            onOpenProjectSharing={projectSharing.open}
          />
        </>
      )}
    </ThreadDetailsSection>
  );
}

const ROW_CLASSNAME = "flex min-h-8 items-center gap-2 px-1.5 text-xs";
const MUTED_ROW_CLASSNAME = `${ROW_CLASSNAME} text-muted-foreground`;

function GuestRow({
  environmentId,
  threadId,
  threadTitle,
  guest,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly guest: SharingThreadGuest;
  readonly canManage: boolean;
}) {
  const name = guestName(guest);
  const { personId } = guest;
  const [confirmingName, setConfirmingName] = useState(false);
  const removeGrant = useAtomCommand(sharingManage.removeGrant, { reportFailure: false });
  const putGrant = useAtomCommand(sharingManage.putGrant, { reportFailure: false });

  const remove = async () => {
    if (personId === null) return;
    const confirmed = await requestConfirmDialog(
      removeFromThreadWarning(guest, threadTitle),
      { variant: "destructive" },
      { confirmLabel: "Remove from thread" },
    );
    if (confirmed !== true) return;
    const result = await removeGrant({
      environmentId,
      input: { personId, target: { kind: "thread", threadId } },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not remove ${name}`,
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };

  const lower = async () => {
    if (personId === null) return;
    const result = await putGrant({
      environmentId,
      input: { personId, target: { kind: "thread", threadId }, level: "view" },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change the level",
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };

  return (
    <div className={ROW_CLASSNAME}>
      <Avatar name={name} />
      <span className="min-w-0 truncate text-foreground">{name}</span>
      {guest.you ? <span className="shrink-0 text-muted-foreground">(you)</span> : null}
      {guest.nameSelfGiven ? (
        personId === null ? (
          <Badge variant="warning" size="sm">
            name they gave
          </Badge>
        ) : (
          <ConfirmNameTag
            environmentId={environmentId}
            person={{ personId, displayName: guest.displayName }}
            canManage={canManage}
            open={confirmingName}
            onOpenChange={setConfirmingName}
          />
        )
      ) : null}
      <span className="flex-1" />
      {canManage && personId !== null ? (
        <Menu>
          <MenuTrigger
            render={<Button size="xs" variant="outline" aria-label={`Level for ${name}`} />}
          >
            {levelLabel(guest.level)}
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            <LevelItems
              current={guest.level}
              onView={() => void lower()}
              onCollaborate={() =>
                openSharingDialog({
                  kind: "promote",
                  environmentId,
                  person: { personId, name, nameSelfGiven: guest.nameSelfGiven },
                  target: { kind: "thread", threadId },
                })
              }
            />
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                openSharingDialog({
                  kind: "device-link",
                  environmentId,
                  person: { personId, name },
                })
              }
            >
              New device link…
            </MenuItem>
            <MenuItem variant="destructive" onClick={() => void remove()}>
              Remove from thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <span className="text-muted-foreground">{levelLabel(guest.level)}</span>
      )}
    </div>
  );
}

/** View and Collaborate as the level menu lists them; the level held is ticked. */
function LevelItems({
  current,
  onView,
  onCollaborate,
}: {
  readonly current: SharingGrantLevel;
  readonly onView: () => void;
  readonly onCollaborate: () => void;
}) {
  return (
    <>
      <MenuItem disabled={current === "view"} onClick={onView}>
        View{current === "view" ? " ✓" : ""}
      </MenuItem>
      <MenuItem disabled={current === "collaborate"} onClick={onCollaborate}>
        Collaborate{current === "collaborate" ? " ✓" : ""}
      </MenuItem>
    </>
  );
}

function OthersDialog({
  open,
  onClose,
  view,
  projectTitle,
  gears,
  onOpenPeople,
  onOpenProjectSharing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly view: ThreadPeopleView;
  readonly projectTitle: string | null;
  /** A guest reads the lists and is offered no way into settings. */
  readonly gears: boolean;
  readonly onOpenPeople: () => void;
  readonly onOpenProjectSharing: () => void;
}) {
  const go = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Others on this thread</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {view.members.length > 0 ? (
            <OthersGroup
              heading="Members"
              gear={gears ? { label: "Open People settings", run: go(onOpenPeople) } : null}
            >
              {view.members.map((member, index) => (
                <OthersRow key={member.personId ?? index} name={memberName(member)} level={null} />
              ))}
            </OthersGroup>
          ) : null}
          {view.throughProject.length > 0 ? (
            <OthersGroup
              heading={projectTitle ?? "This thread's project"}
              gear={
                gears ? { label: "Manage project sharing", run: go(onOpenProjectSharing) } : null
              }
            >
              {view.throughProject.map((guest, index) => (
                <OthersRow
                  key={guest.personId ?? index}
                  name={guestName(guest)}
                  level={guest.level}
                />
              ))}
            </OthersGroup>
          ) : null}
          {view.throughAncestor.length > 0 ? (
            <OthersGroup heading="Through the thread this one works for" gear={null}>
              {view.throughAncestor.map((guest, index) => (
                <OthersRow
                  key={guest.personId ?? index}
                  name={guestName(guest)}
                  level={guest.level}
                />
              ))}
            </OthersGroup>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function OthersGroup({
  heading,
  gear,
  children,
}: {
  readonly heading: string;
  readonly gear: { readonly label: string; readonly run: () => void } | null;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex min-h-6 items-center justify-between">
        <h3 className="min-w-0 truncate text-2xs font-medium text-muted-foreground">{heading}</h3>
        {gear === null ? null : (
          <Button size="icon-xs" variant="ghost-muted" aria-label={gear.label} onClick={gear.run}>
            <SettingsIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function OthersRow({
  name,
  level,
}: {
  readonly name: string;
  readonly level: SharingGrantLevel | null;
}) {
  return (
    <div className="flex min-h-7.5 items-center gap-2 text-sm">
      <Avatar name={name} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {level === null ? null : (
        <span className="text-xs text-muted-foreground">{levelLabel(level)}</span>
      )}
    </div>
  );
}
