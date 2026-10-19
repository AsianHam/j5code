import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { AuthAccessReadScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type {
  HeldPersonLevel,
  PeopleEntry,
  PeopleLink,
  PersonDevice,
  PersonLevel,
} from "@t3tools/contracts/j5";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LogOutIcon,
  PenLineIcon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ConnectionStatusDot } from "../../components/ConnectionStatusDot";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ITEM_ROW_CLASSNAME } from "../../components/settings/itemRows";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { requestConfirmDialog } from "../../confirmDialog";
import { readPrimaryEnvironmentTarget } from "../../environments/primary/target";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProject, useProjects, useThreadShell } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useConnectionAccess } from "./access";
import { PersonAvatar } from "./PersonAvatar";
import {
  deviceCeiling,
  deviceLabel,
  devicesLabel,
  levelLabel,
  levelsAt,
  linkInForce,
  raisesToWriting,
  removeLevelWarning,
  peopleServerState,
  removePersonWarning,
  rosterProjectIds,
  type SummaryPart,
  summaryParts,
  threadsLabel,
} from "./people.logic";
import { IconAction } from "./IconAction";
import { AccessRowLine, LinkLine, WritingWarning } from "./ShareDialog";
import { useAccessRows } from "./scopeAccess";
import { openSharingDialog } from "./sharingDialogs";
import {
  linksQuery,
  peopleQuery,
  refreshSharing,
  refusalMessage,
  sharingManage,
} from "./sharingManage";

const ROW_NOTE_CLASSNAME = `${ITEM_ROW_CLASSNAME} text-xs text-muted-foreground`;

/** Runs one change, says so plainly when the server refuses, and reads everything again. */
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
 * Settings › People (People and access AC27, AC41, AC48 to AC51). For a server the person owns:
 * everyone on it with their levels and devices, the links in force, and Share… for the server or
 * a project. For a server they do not own: only their own row, from which they rename themselves
 * and leave what they hold. A picker chooses among the servers.
 */
export function PeoplePage() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [hasOwnServer] = useState(() => readPrimaryEnvironmentTarget() !== null);
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId =
    chosen ??
    (environments.some((environment) => environment.environmentId === primaryEnvironmentId)
      ? primaryEnvironmentId
      : (environments[0]?.environmentId ?? null));
  if (environmentId === null) {
    const none =
      peopleServerState({ catalogReady: isReady, listed: environments.length, hasOwnServer }) ===
      "none";
    return (
      <SettingsPageContainer width="wide">
        <SettingsSection title="People">
          <p className={ROW_NOTE_CLASSNAME}>
            {none ? "Connect to a server to see who is on it." : "Reading who is on this server…"}
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  const picker =
    environments.length > 1 ? (
      <Select value={environmentId} onValueChange={(next) => setChosen(next as EnvironmentId)}>
        <SelectTrigger size="xs" aria-label="Server">
          <SelectValue>
            {environments.find((environment) => environment.environmentId === environmentId)
              ?.label ?? "Server"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {environments.map((environment) => (
            <SelectItem
              hideIndicator
              key={environment.environmentId}
              value={environment.environmentId}
            >
              {environment.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : null;
  return <ServerPeople key={environmentId} environmentId={environmentId} picker={picker} />;
}

function ServerPeople({
  environmentId,
  picker,
}: {
  readonly environmentId: EnvironmentId;
  readonly picker: React.ReactNode;
}) {
  const access = useConnectionAccess(environmentId);
  const canReadPeople = useEnvironmentScope(environmentId, AuthAccessReadScope);
  if (access === null) {
    return (
      <SettingsPageContainer width="wide">
        <SettingsSection title="People" titleAction={picker}>
          <p className={ROW_NOTE_CLASSNAME}>Reading who you are on this server…</p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  if (access.kind !== "person") {
    return (
      <SettingsPageContainer width="wide">
        <SettingsSection title="People" titleAction={picker}>
          <p className={ROW_NOTE_CLASSNAME}>
            {access.kind === "unknown"
              ? "This device has not said whose it is yet."
              : "This connection is not a person's."}
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  // An Owner whose device was paired without permission to see who has access gets their own
  // row, from which they still rename themselves and leave (AC48).
  return access.owner && canReadPeople ? (
    <OwnedServerPeople environmentId={environmentId} picker={picker} />
  ) : (
    <SettingsPageContainer width="wide">
      <SettingsSection title="People" titleAction={picker}>
        <OwnRow
          environmentId={environmentId}
          personId={access.personId}
          name={access.name}
          levels={access.levels}
          firstOwner={access.firstOwner}
        />
      </SettingsSection>
      <ProjectRosters environmentId={environmentId} levels={access.levels} />
    </SettingsPageContainer>
  );
}

function OwnedServerPeople({
  environmentId,
  picker,
}: {
  readonly environmentId: EnvironmentId;
  readonly picker: React.ReactNode;
}) {
  const canManage = useAtomValue(sharingManage.setLevel.permissionAtom(environmentId));
  const people = useEnvironmentQuery(peopleQuery(environmentId));
  const links = useEnvironmentQuery(linksQuery(environmentId));
  // People join, leave and pair devices without this client doing anything.
  useEffect(() => refreshSharing(environmentId), [environmentId]);
  const nowMs = Date.parse(useNowMinute());
  const everyone = (people.data?.people ?? []).toSorted(byStanding);
  const inForce = (links.data?.links ?? []).filter((link) => linkInForce(link, nowMs));

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        title="People"
        titleAction={
          <span className="flex items-center gap-2">
            {picker}
            {people.data === null ? null : (
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                {everyone.length} {everyone.length === 1 ? "person" : "people"}
              </span>
            )}
          </span>
        }
        headerAction={
          <Button
            size="xs"
            disabled={!canManage}
            onClick={() => openSharingDialog({ kind: "share", environmentId, scope: null })}
          >
            <UserPlusIcon className="size-3" />
            Share…
          </Button>
        }
      >
        {people.data === null ? (
          <p className={ROW_NOTE_CLASSNAME}>{people.error ?? "Reading who is on this server…"}</p>
        ) : (
          everyone.map((person) => (
            <PersonRow
              key={person.personId}
              environmentId={environmentId}
              person={person}
              canManage={canManage}
              nowMs={nowMs}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Links"
        titleAction={
          links.data === null ? null : (
            <span className="text-xs text-muted-foreground">{inForce.length} in force</span>
          )
        }
      >
        {links.data === null ? (
          <p className={ROW_NOTE_CLASSNAME}>{links.error ?? "Reading links…"}</p>
        ) : inForce.length === 0 ? (
          <p className={ROW_NOTE_CLASSNAME}>
            No links in force. Share the server, a project or a thread to make one.
          </p>
        ) : (
          <div className="py-1">
            {inForce.map((link) => (
              <LinkLine
                key={link.linkId}
                environmentId={environmentId}
                link={link}
                canManage={canManage}
                nowMs={nowMs}
                indent={false}
                label={<LinkOpens environmentId={environmentId} link={link} />}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const RANK: Record<PersonLevel, number> = { owner: 0, collaborator: 1, viewer: 2 };
const highest = (person: PeopleEntry) =>
  Math.min(3, ...person.levels.map((held) => RANK[held.level]));
const byStanding = (left: PeopleEntry, right: PeopleEntry) =>
  Number(right.firstOwner) - Number(left.firstOwner) ||
  highest(left) - highest(right) ||
  (left.name ?? "").localeCompare(right.name ?? "");

/** What a link opens and who it is for, ahead of its own details, in the Links section. */
function LinkOpens({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeopleLink;
}) {
  const title = useHeldTitle(environmentId, link.scope);
  const who = link.use === "one" ? `${link.personName ?? "One person"} · ` : "";
  return (
    <>
      {who}
      {link.kind === "device" ? "another device · " : title === null ? "" : `${title} · `}
    </>
  );
}

/** The name a person knows a held scope by; the server's is "whole server". */
function useHeldTitle(
  environmentId: EnvironmentId,
  scope: HeldPersonLevel["scope"] | null,
): string | null {
  const thread = useThreadShell(
    scope?.kind === "thread" ? scopeThreadRef(environmentId, scope.threadId) : null,
  );
  const project = useProject(
    scope?.kind === "project" ? scopeProjectRef(environmentId, scope.projectId) : null,
  );
  if (scope === null) return null;
  if (scope.kind === "server") return "whole server";
  if (scope.kind === "project") return project?.title ?? "a project that is no longer listed";
  return thread?.title ?? "a thread that is no longer listed";
}

/** "Owner · whole server · 2 devices", "Collaborator · [icon] Live test repo · Viewer · 1 thread". */
function Summary({
  environmentId,
  levels,
  devices,
}: {
  readonly environmentId: EnvironmentId;
  readonly levels: ReadonlyArray<HeldPersonLevel>;
  readonly devices: number | null;
}) {
  const parts = summaryParts(levels);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {parts.length === 0 ? <span>Nothing shared yet</span> : null}
      {parts.map((part, index) => (
        // The parts are rebuilt whole from the levels on every change.
        // oxlint-disable-next-line react/no-array-index-key -- see above
        <SummaryItem key={index} environmentId={environmentId} part={part} first={index === 0} />
      ))}
      {devices === null ? null : <span>· {devicesLabel(devices)}</span>}
    </p>
  );
}

function SummaryItem({
  environmentId,
  part,
  first,
}: {
  readonly environmentId: EnvironmentId;
  readonly part: SummaryPart;
  readonly first: boolean;
}) {
  const project = useProject(
    part.kind === "project" ? scopeProjectRef(environmentId, part.projectId as ProjectId) : null,
  );
  const where =
    part.kind === "server"
      ? "whole server"
      : part.kind === "threads"
        ? threadsLabel(part.count)
        : (project?.title ?? "a project that is no longer listed");
  return (
    <span className="flex items-center gap-1.5">
      {first ? null : <span>·</span>}
      {levelLabel(part.level)} ·{project === null ? null : <ProjectFavicon project={project} />}
      <span>{where}</span>
    </span>
  );
}

/**
 * One person on a server the asker owns. Expanded, each level they hold with its control and
 * remove, and their devices with Revoke. The first owner has no level control or removal, and
 * keeps rename and devices (AC51).
 */
function PersonRow({
  environmentId,
  person,
  canManage,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: PeopleEntry;
  readonly canManage: boolean;
  readonly nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const change = useChange(environmentId);
  const removePerson = useAtomCommand(sharingManage.removePerson, { reportFailure: false });
  const name = person.name ?? "Someone without a name yet";

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      removePersonWarning(person.name),
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
        <PersonAvatar name={person.name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">{name}</h3>
            {person.you ? (
              <Badge variant="outline" size="sm">
                you
              </Badge>
            ) : null}
            {person.firstOwner ? (
              <Badge variant="outline" size="sm">
                first owner
              </Badge>
            ) : null}
          </div>
          <Summary
            environmentId={environmentId}
            levels={person.levels}
            devices={person.devices.length}
          />
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`More actions for ${name}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!canManage && !person.you}
              onClick={() =>
                openSharingDialog({
                  kind: "rename",
                  environmentId,
                  person: { personId: person.personId, name: person.name, you: person.you },
                })
              }
            >
              Rename…
            </MenuItem>
            {person.firstOwner ? null : (
              <>
                <MenuSeparator />
                <MenuItem variant="destructive" disabled={!canManage} onClick={() => void remove()}>
                  Remove…
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>
      {expanded ? (
        <div className="mt-3 ml-9.5 flex flex-col gap-3 sm:ml-16.5">
          {person.levels.length > 0 ? (
            <div>
              <h4 className="mb-0.5 text-2xs font-medium text-muted-foreground">Reaches</h4>
              {person.levels.map((held) => (
                <HeldLevelLine
                  key={JSON.stringify(held.scope)}
                  environmentId={environmentId}
                  person={person}
                  held={held}
                  canManage={canManage}
                />
              ))}
            </div>
          ) : null}
          <div>
            <h4 className="mb-0.5 text-2xs font-medium text-muted-foreground">Devices</h4>
            {person.devices.length === 0 ? (
              <p className="text-xs text-muted-foreground">No devices paired.</p>
            ) : (
              person.devices.map((device) => (
                <DeviceLine
                  key={device.sessionId}
                  environmentId={environmentId}
                  device={device}
                  canManage={canManage}
                />
              ))
            )}
            {person.unusedLinks
              .filter((link) => linkInForce(link, nowMs))
              .map((link) => (
                <LinkLine
                  key={link.linkId}
                  environmentId={environmentId}
                  link={link}
                  canManage={canManage}
                  nowMs={nowMs}
                  indent={false}
                />
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One level a person holds, with its control and remove; the first owner's are fixed (AC51). */
function HeldLevelLine({
  environmentId,
  person,
  held,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: PeopleEntry;
  readonly held: HeldPersonLevel;
  readonly canManage: boolean;
}) {
  const title = useHeldTitle(environmentId, held.scope) ?? "";
  const project = useProject(
    held.scope.kind === "project" ? scopeProjectRef(environmentId, held.scope.projectId) : null,
  );
  const change = useChange(environmentId);
  const setLevel = useAtomCommand(sharingManage.setLevel, { reportFailure: false });
  const removeLevel = useAtomCommand(sharingManage.removeLevel, { reportFailure: false });
  const [pending, setPending] = useState<PersonLevel | null>(null);
  const controls = canManage && !person.firstOwner;

  const apply = async (level: PersonLevel) => {
    setPending(null);
    await change("Could not change the level", () =>
      setLevel({ environmentId, input: { personId: person.personId, scope: held.scope, level } }),
    );
  };
  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      removeLevelWarning(person.name, title),
      { variant: "destructive" },
      { confirmLabel: "Remove" },
    );
    if (confirmed !== true) return;
    await change("Could not remove the level", () =>
      removeLevel({ environmentId, input: { personId: person.personId, scope: held.scope } }),
    );
  };

  return (
    <div className="flex flex-col gap-2 py-0.5">
      <div className="flex min-h-7 items-center gap-2 text-xs">
        {project === null ? null : <ProjectFavicon project={project} />}
        <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
        {controls ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <Select
              value={pending ?? held.level}
              onValueChange={(next) => {
                const level = next as PersonLevel;
                if (level === held.level) return;
                if (raisesToWriting(held.level, level)) setPending(level);
                else void apply(level);
              }}
            >
              <SelectTrigger size="xs" aria-label={`Level on ${title}`}>
                <SelectValue>{levelLabel(pending ?? held.level)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {levelsAt(held.scope).map((level) => (
                  <SelectItem hideIndicator key={level} value={level}>
                    {levelLabel(level)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <IconAction
              label={`Take ${title} away from ${person.name ?? "this person"}`}
              onClick={() => void remove()}
            >
              <XIcon className="size-3.5" />
            </IconAction>
          </span>
        ) : (
          <span className="text-muted-foreground">{levelLabel(held.level)}</span>
        )}
        {/* A person leaves what they hold, whatever their device may manage; the first owner
            leaves nothing (AC48, AC51). */}
        {person.you && !person.firstOwner ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            onClick={() => openSharingDialog({ kind: "leave", environmentId, scope: held.scope })}
          >
            <LogOutIcon className="size-3" />
            Leave
          </Button>
        ) : null}
      </div>
      {pending !== null ? (
        <div className="flex flex-col gap-2">
          <WritingWarning name={person.name} />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => void apply(pending)}>
              Make {levelLabel(pending)}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One paired device, with the permissions it was paired with when it has a ceiling (AC18). */
function DeviceLine({
  environmentId,
  device,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly device: PersonDevice;
  readonly canManage: boolean;
}) {
  const change = useChange(environmentId);
  const revokeDevice = useAtomCommand(sharingManage.revokeDevice, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const ceiling = deviceCeiling(device);
  return (
    <div className="flex min-h-7 items-center gap-2 text-xs">
      <ConnectionStatusDot
        tooltipText={device.connected ? "Connected" : "Not connected"}
        dotClassName={device.connected ? "bg-success" : "bg-muted-foreground/30"}
      />
      <span className="min-w-0 truncate text-foreground">{deviceLabel(device)}</span>
      {ceiling === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" size="sm">
                limited
              </Badge>
            }
          />
          <TooltipPopup side="top">
            Paired with only: {ceiling.join(", ")}. It keeps only these, whatever its person's
            level. Pair it again to change them.
          </TooltipPopup>
        </Tooltip>
      )}
      <span className="flex-1" />
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

/**
 * The person's own row on a server they do not own (AC27, AC28): their name, what they hold, and
 * Leave on each level, with Rename. Their devices are an Owner's to see (AC26).
 */
function OwnRow({
  environmentId,
  personId,
  name,
  levels,
  firstOwner,
}: {
  readonly environmentId: EnvironmentId;
  readonly personId: string;
  readonly name: string | null;
  readonly levels: ReadonlyArray<HeldPersonLevel>;
  readonly firstOwner: boolean;
}) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex items-center gap-2.5">
        <PersonAvatar name={name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">
              {name ?? "You have not given your name yet"}
            </h3>
            <Badge variant="outline" size="sm">
              you
            </Badge>
          </div>
          <Summary environmentId={environmentId} levels={levels} devices={null} />
        </div>
        <IconAction
          label="Rename yourself"
          variant="ghost"
          onClick={() =>
            openSharingDialog({
              kind: "rename",
              environmentId,
              person: { personId, name, you: true },
            })
          }
        >
          <PenLineIcon className="size-3.5" />
        </IconAction>
      </div>
      {levels.length > 0 && !firstOwner ? (
        <div className="mt-3 ml-9.5 flex flex-col">
          {levels.map((held) => (
            <OwnLevelLine
              key={JSON.stringify(held.scope)}
              environmentId={environmentId}
              held={held}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OwnLevelLine({
  environmentId,
  held,
}: {
  readonly environmentId: EnvironmentId;
  readonly held: HeldPersonLevel;
}) {
  const title = useHeldTitle(environmentId, held.scope) ?? "";
  const project = useProject(
    held.scope.kind === "project" ? scopeProjectRef(environmentId, held.scope.projectId) : null,
  );
  return (
    <div className="flex min-h-7 items-center gap-2 text-xs">
      {project === null ? null : <ProjectFavicon project={project} />}
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      <span className="text-muted-foreground">{levelLabel(held.level)}</span>
      <Button
        size="xs"
        variant="ghost-destructive"
        onClick={() => openSharingDialog({ kind: "leave", environmentId, scope: held.scope })}
      >
        <LogOutIcon className="size-3" />
        Leave
      </Button>
    </div>
  );
}

/**
 * Who reaches each project this person reaches, for someone who manages no access (AC26): the
 * names and levels the project's own list shows anyone in it. Changing them, links and devices
 * are an Owner's; a thread's people are shown on the thread.
 */
function ProjectRosters({
  environmentId,
  levels,
}: {
  readonly environmentId: EnvironmentId;
  readonly levels: ReadonlyArray<HeldPersonLevel>;
}) {
  const projects = useProjects();
  const listed = projects.filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const shown = new Set(
    rosterProjectIds(
      levels,
      listed.map((project) => project.id),
    ),
  );
  const rostered = listed.filter((project) => shown.has(project.id));
  if (rostered.length === 0) return null;
  return (
    <SettingsSection title="Projects">
      {rostered.map((project) => (
        <ProjectRosterRow key={project.id} environmentId={environmentId} project={project} />
      ))}
    </SettingsSection>
  );
}

function ProjectRosterRow({
  environmentId,
  project,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex items-center gap-2.5">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={
            expanded ? `Hide who reaches ${project.title}` : `Show who reaches ${project.title}`
          }
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <ProjectFavicon project={project} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {project.title}
        </h3>
      </div>
      {expanded ? <ProjectRoster environmentId={environmentId} projectId={project.id} /> : null}
    </div>
  );
}

function ProjectRoster({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const scope = useMemo(() => ({ kind: "project" as const, projectId }), [projectId]);
  const { rows, error } = useAccessRows(environmentId, scope);
  const nowMs = Date.parse(useNowMinute());
  return (
    <div className="mt-2 ml-9.5 flex flex-col">
      {rows === null ? (
        <p className={ROW_NOTE_CLASSNAME}>{error ?? "Reading who reaches this project…"}</p>
      ) : (
        rows.map((row, index) => (
          <AccessRowLine
            // Someone who is not an Owner is told no ids.
            key={row.personId ?? index}
            environmentId={environmentId}
            scope={scope}
            row={row}
            canManage={false}
            unusedLinks={[]}
            nowMs={nowMs}
          />
        ))
      )}
    </div>
  );
}
