import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthAccessReadScope, type EnvironmentId } from "@t3tools/contracts";
import type {
  SharingDevice,
  SharingGrant,
  SharingOpenLink,
  SharingPendingLink,
  SharingPerson,
} from "@t3tools/contracts/j5";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  Link2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ConnectionStatusDot } from "../../components/ConnectionStatusDot";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ITEM_ROW_CLASSNAME } from "../../components/settings/itemRows";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { requestConfirmDialog } from "../../confirmDialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProject, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConfirmNameTag } from "./ConfirmNameTag";
import { LevelControl } from "./LevelControl";
import { useOwnerName } from "./ownerName";
import {
  deviceLabel,
  guestSummary,
  joinLinkRowMeta,
  removeGrantWarning,
  removePersonWarning,
  splitPeople,
} from "./people.logic";
import { initialsOf, lifetimeLeft, openLinkIsActive } from "./shareLink.logic";
import { useLinkAddress } from "./ShareLinkPanel";
import { openSharingDialog } from "./sharingDialogs";
import {
  linkSecretMadeHere,
  openLinksQuery,
  peopleQuery,
  refreshSharing,
  refusalMessage,
  sharingManage,
} from "./sharingManage";

const ROW_NOTE_CLASSNAME = `${ITEM_ROW_CLASSNAME} text-xs text-muted-foreground`;

function Avatar({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground"
    >
      {initialsOf(name)}
    </span>
  );
}

/** Runs one of sharing's changes, says so plainly when the server refuses, and reads the lists again. */
function useChange(environmentId: EnvironmentId) {
  return async (
    title: string,
    run: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    const result = await run();
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title,
        description: refusalMessage(result as Parameters<typeof refusalMessage>[0]),
      });
    }
    refreshSharing(environmentId);
    return result._tag === "Success";
  };
}

/**
 * Settings › People: everyone on this server (Shared server AC18). Guests with what each can
 * reach and their devices, the join links in force, and the members. A connection that cannot
 * manage access reads the page and changes nothing.
 */
export function PeoplePage() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  if (environmentId === null || !canRead) {
    return (
      <SettingsPageContainer width="wide">
        <SettingsSection title="People">
          <p className={ROW_NOTE_CLASSNAME}>
            This connection cannot see who is on this server. Ask a member who manages access.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <People environmentId={environmentId} />;
}

function People({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const people = useEnvironmentQuery(peopleQuery(environmentId));
  const links = useEnvironmentQuery(openLinksQuery(environmentId));
  // People join, leave and pair devices without this client doing anything.
  useEffect(() => refreshSharing(environmentId), [environmentId]);
  const nowMs = Date.parse(useNowMinute());

  const { guests, members } = splitPeople(people.data?.people ?? []);
  const activeLinks = (links.data?.links ?? []).filter((link) => openLinkIsActive(link, nowMs));
  const countLabel = (count: number, one: string, many: string) => (
    <span className="text-xs text-muted-foreground">
      {count} {count === 1 ? one : many}
    </span>
  );

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        title="Guests"
        titleAction={people.data === null ? null : countLabel(guests.length, "person", "people")}
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canManage}
              onClick={() =>
                openSharingDialog({ kind: "join-link", environmentId, threadId: null })
              }
            >
              <Link2Icon className="size-3" />
              Join link
            </Button>
            <Button
              size="xs"
              disabled={!canManage}
              onClick={() => openSharingDialog({ kind: "share", environmentId, target: null })}
            >
              <PlusIcon className="size-3" />
              Share
            </Button>
          </div>
        }
      >
        {people.data === null ? (
          <p className={ROW_NOTE_CLASSNAME}>{people.error ?? "Reading who is on this server…"}</p>
        ) : guests.length === 0 ? (
          <p className={ROW_NOTE_CLASSNAME}>
            No guests yet. Share a thread or a project to bring someone in.
          </p>
        ) : (
          guests.map((guest) => (
            <GuestRow
              key={guest.personId}
              environmentId={environmentId}
              person={guest}
              canManage={canManage}
              nowMs={nowMs}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Join links"
        titleAction={
          links.data === null ? null : (
            <span className="text-xs text-muted-foreground">{activeLinks.length} active</span>
          )
        }
      >
        {links.data === null ? (
          <p className={ROW_NOTE_CLASSNAME}>{links.error ?? "Reading join links…"}</p>
        ) : activeLinks.length === 0 ? (
          <p className={ROW_NOTE_CLASSNAME}>
            No join links. A join link lets several people open one thread to read it.
          </p>
        ) : (
          activeLinks.map((link) => (
            <JoinLinkRow
              key={link.linkId}
              environmentId={environmentId}
              link={link}
              canManage={canManage}
              nowMs={nowMs}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Members"
        titleAction={people.data === null ? null : countLabel(members.length, "person", "people")}
      >
        {members.map((member) => (
          <MemberRow
            key={member.personId}
            environmentId={environmentId}
            member={member}
            canManage={canManage}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * A member reaches everything and has no controls here. The row that is the person asking, the
 * server's owner, carries a "You" chip and the way to set or change the name guests and agents
 * know them by.
 */
function MemberRow({
  environmentId,
  member,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: SharingPerson;
  readonly canManage: boolean;
}) {
  // The list is read again whenever a name changes, on this client or another, so it is the
  // name shown. What this client knows only fills the moment before the list has it.
  const known = useOwnerName(environmentId);
  const name = member.displayName ?? (member.you ? (known ?? null) : null);
  const label = name ?? (member.you ? "You have not set a name" : "Member");
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex items-center gap-2.5">
        <Avatar name={name ?? "?"} />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">{label}</h3>
            {member.you ? (
              <Badge variant="outline" size="sm">
                You
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Reaches everything on this server · devices in Connections
          </p>
        </div>
        {member.you ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canManage}
            onClick={() => openSharingDialog({ kind: "owner-name", environmentId })}
          >
            {name === null ? "Set your name" : "Change name"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function GuestRow({
  environmentId,
  person,
  canManage,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: SharingPerson;
  readonly canManage: boolean;
  readonly nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingName, setConfirmingName] = useState(false);
  const change = useChange(environmentId);
  const removePerson = useAtomCommand(sharingManage.removePerson, { reportFailure: false });
  const name = person.displayName ?? "Unnamed guest";
  const projects = person.grants.filter((grant) => grant.target.kind === "project");
  const threads = person.grants.filter((grant) => grant.target.kind === "thread");
  const asPerson = { personId: person.personId, name };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      removePersonWarning(person),
      { variant: "destructive" },
      { confirmLabel: "Remove person" },
    );
    if (confirmed !== true) return;
    await change(`Could not remove ${name}`, () =>
      removePerson({ environmentId, input: { personId: person.personId } }),
    );
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex items-center gap-2.5">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide details for ${name}` : `Show details for ${name}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">{name}</h3>
            {person.nameSelfGiven ? (
              <ConfirmNameTag
                environmentId={environmentId}
                person={person}
                canManage={canManage}
                open={confirmingName}
                onOpenChange={setConfirmingName}
              />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{guestSummary(person)}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={!canManage}
                aria-label={`More actions for ${name}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {person.nameSelfGiven ? (
              <MenuItem onClick={() => setConfirmingName(true)}>Confirm name…</MenuItem>
            ) : null}
            <MenuItem
              onClick={() => openSharingDialog({ kind: "rename", environmentId, person: asPerson })}
            >
              Rename…
            </MenuItem>
            <MenuItem
              onClick={() =>
                openSharingDialog({ kind: "device-link", environmentId, person: asPerson })
              }
            >
              New device link…
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void remove()}>
              Remove person…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {expanded ? (
        <div className="mt-3 ml-9.5 flex flex-col gap-3 sm:ml-16.5">
          {projects.length > 0 ? (
            <GrantList
              heading="Projects"
              environmentId={environmentId}
              person={person}
              grants={projects}
              canManage={canManage}
            />
          ) : null}
          <div>
            {threads.length > 0 ? (
              <GrantList
                heading="Threads"
                environmentId={environmentId}
                person={person}
                grants={threads}
                canManage={canManage}
              />
            ) : null}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canManage}
              onClick={() =>
                openSharingDialog({ kind: "share", environmentId, target: null, person: asPerson })
              }
            >
              <PlusIcon className="size-3" />
              Add a project or thread…
            </Button>
          </div>
          <div>
            <h4 className="mb-0.5 text-2xs font-medium text-muted-foreground">Devices</h4>
            {person.devices.map((device) => (
              <DeviceLine
                key={device.sessionId}
                environmentId={environmentId}
                device={device}
                canManage={canManage}
              />
            ))}
            {person.pendingLinks.map((link) => (
              <PendingLinkLine
                key={link.linkId}
                environmentId={environmentId}
                link={link}
                canManage={canManage}
                nowMs={nowMs}
              />
            ))}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canManage}
              onClick={() =>
                openSharingDialog({ kind: "device-link", environmentId, person: asPerson })
              }
            >
              <PlusIcon className="size-3" />
              New device link…
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GrantList({
  heading,
  environmentId,
  person,
  grants,
  canManage,
}: {
  readonly heading: string;
  readonly environmentId: EnvironmentId;
  readonly person: SharingPerson;
  readonly grants: ReadonlyArray<SharingGrant>;
  readonly canManage: boolean;
}) {
  return (
    <div>
      <h4 className="mb-0.5 text-2xs font-medium text-muted-foreground">{heading}</h4>
      {grants.map((grant) => (
        <GrantLine
          key={
            grant.target.kind === "project"
              ? `project:${grant.target.projectId}`
              : `thread:${grant.target.threadId}`
          }
          environmentId={environmentId}
          person={person}
          grant={grant}
          canManage={canManage}
        />
      ))}
    </div>
  );
}

function GrantLine({
  environmentId,
  person,
  grant,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: SharingPerson;
  readonly grant: SharingGrant;
  readonly canManage: boolean;
}) {
  const { target } = grant;
  const thread = useThreadShell(
    target.kind === "thread" ? scopeThreadRef(environmentId, target.threadId) : null,
  );
  const project = useProject(
    target.kind === "project"
      ? scopeProjectRef(environmentId, target.projectId)
      : thread === null
        ? null
        : scopeProjectRef(environmentId, thread.projectId),
  );
  const title =
    target.kind === "project"
      ? (project?.title ?? "A project that is no longer listed")
      : (thread?.title ?? "A thread that is no longer listed");
  const change = useChange(environmentId);
  const removeGrant = useAtomCommand(sharingManage.removeGrant, { reportFailure: false });
  const name = person.displayName ?? "this person";

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      removeGrantWarning(name, title),
      { variant: "destructive" },
      { confirmLabel: "Stop sharing" },
    );
    if (confirmed !== true) return;
    await change(`Could not stop sharing ${title}`, () =>
      removeGrant({ environmentId, input: { personId: person.personId, target } }),
    );
  };

  return (
    <div className="flex min-h-7 items-center gap-2 text-xs">
      {project === null ? null : <ProjectFavicon project={project} />}
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      <LevelControl
        environmentId={environmentId}
        person={person}
        grant={grant}
        canManage={canManage}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={!canManage}
              aria-label={`Stop sharing ${title} with ${name}`}
              onClick={() => void remove()}
            />
          }
        >
          <XIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Remove</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function DeviceLine({
  environmentId,
  device,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly device: SharingDevice;
  readonly canManage: boolean;
}) {
  const change = useChange(environmentId);
  const revokeDevice = useAtomCommand(sharingManage.revokeDevice, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-7 items-center gap-2 text-xs">
      <ConnectionStatusDot
        tooltipText={device.connected ? "Connected" : "Not connected"}
        dotClassName={device.connected ? "bg-success" : "bg-muted-foreground/30"}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{deviceLabel(device)}</span>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={!canManage || busy}
        onClick={() => {
          setBusy(true);
          void change("Could not revoke the device", () =>
            revokeDevice({ environmentId, input: { sessionId: device.sessionId } }),
          ).finally(() => setBusy(false));
        }}
      >
        {busy ? "Revoking…" : "Revoke"}
      </Button>
    </div>
  );
}

function CopyLinkButton({
  environmentId,
  linkId,
  kind,
}: {
  readonly environmentId: EnvironmentId;
  readonly linkId: string;
  readonly kind: "named" | "join";
}) {
  const addressFor = useLinkAddress(environmentId, kind);
  const secret = linkSecretMadeHere(linkId);
  const address = secret === null ? null : addressFor(secret);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "link",
    onCopy: () => toastManager.add({ type: "success", title: "Link copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  // A link's secret is shown once, to the client that made it; no other client can copy it.
  if (address === null) return null;
  return (
    <Button size="xs" variant="outline" onClick={() => copyToClipboard(address, undefined)}>
      {isCopied ? "Copied" : "Copy link"}
    </Button>
  );
}

function PendingLinkLine({
  environmentId,
  link,
  canManage,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: SharingPendingLink;
  readonly canManage: boolean;
  readonly nowMs: number;
}) {
  const change = useChange(environmentId);
  const revokeLink = useAtomCommand(sharingManage.revokeLink, { reportFailure: false });
  const left = lifetimeLeft(link.expiresAt.epochMilliseconds, nowMs);
  if (left === null) return null;
  return (
    <div className="flex min-h-7 items-center gap-2 text-xs">
      <ConnectionStatusDot tooltipText="A link that has not been used" dotClassName="bg-warning" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Unused link · {left} left
      </span>
      <CopyLinkButton environmentId={environmentId} linkId={link.linkId} kind="named" />
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={!canManage}
        onClick={() =>
          void change("Could not revoke the link", () =>
            revokeLink({ environmentId, input: { linkId: link.linkId } }),
          )
        }
      >
        Revoke
      </Button>
    </div>
  );
}

function JoinLinkRow({
  environmentId,
  link,
  canManage,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: SharingOpenLink;
  readonly canManage: boolean;
  readonly nowMs: number;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, link.threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const title = thread?.title ?? "A thread that is no longer listed";
  const change = useChange(environmentId);
  const revokeOpenLink = useAtomCommand(sharingManage.revokeOpenLink, { reportFailure: false });

  const revoke = async () => {
    const confirmed = await requestConfirmDialog(
      `Revoke the join link for ${title}? Nobody new can join with it. People who already joined keep their access until you remove them.`,
      { variant: "destructive" },
      { confirmLabel: "Revoke link" },
    );
    if (confirmed !== true) return;
    await change("Could not revoke the link", () =>
      revokeOpenLink({ environmentId, input: { linkId: link.linkId } }),
    );
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex items-center gap-2.5">
        <ConnectionStatusDot
          tooltipText="People can join with this link"
          dotClassName="bg-warning"
        />
        {project === null ? null : <ProjectFavicon project={project} />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">{joinLinkRowMeta(link, nowMs)}</p>
        </div>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            openSharingDialog({ kind: "join-link", environmentId, threadId: link.threadId })
          }
        >
          Details
        </Button>
        <CopyLinkButton environmentId={environmentId} linkId={link.linkId} kind="join" />
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={!canManage}
          onClick={() => void revoke()}
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}
