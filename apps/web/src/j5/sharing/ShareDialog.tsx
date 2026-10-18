import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PeopleEntry, PeopleLink, PersonLevel, PersonScope } from "@t3tools/contracts/j5";
import { isPersonName, levelReaches } from "@t3tools/contracts/j5";
import { Link2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../../components/ui/autocomplete";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinkLifetimeRow } from "./LinkLifetimeRow";
import { PersonAvatar } from "./PersonAvatar";
import {
  type AccessRow,
  historyNote,
  levelLabel,
  levelsAt,
  linkMeta,
  linksOn,
  peopleMatching,
  personNamed,
  raisesToWriting,
  sameScope,
  widerLabel,
  writingWarning,
} from "./people.logic";
import { useAccessRows, useScopeTitle } from "./scopeAccess";
import {
  DEFAULT_LINK_LIFETIME,
  lifetimeLeft,
  type LinkLifetime,
  NAME_NOT_USABLE,
} from "./shareLink.logic";
import { ShareLinkPanel, useLinkAddress } from "./ShareLinkPanel";
import {
  linksQuery,
  peopleQuery,
  refreshSharing,
  refusalMessage,
  sharingManage,
} from "./sharingManage";
import { WhatPicker } from "./WhatPicker";

type AddMode = "person" | "anyone";

/**
 * The one Share dialog, the same for a thread, a project and the whole server (People and access
 * AC34 to AC41): who already reaches the thing, with their levels and where each is held; the
 * links in force; and a form that makes a link, or gives someone already on the server more with
 * no link (AC35). Only an Owner's device opens it with controls; the server checks every change.
 */
export function ShareDialog({
  environmentId,
  scope: givenScope,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** `null` when opened from the People page: the dialog asks, the server or a project. */
  readonly scope: PersonScope | null;
  readonly onClose: () => void;
}) {
  const [pickedScope, setPickedScope] = useState<PersonScope | null>(null);
  const scope = givenScope ?? pickedScope;
  const titles = useScopeTitle(environmentId, scope);
  const canManage = useAtomValue(sharingManage.createLink.permissionAtom(environmentId));
  const access = useAccessRows(environmentId, scope);
  const people = useEnvironmentQuery(canManage ? peopleQuery(environmentId) : null);
  const links = useEnvironmentQuery(canManage ? linksQuery(environmentId) : null);
  // People join and links are used without this client doing anything; each opening reads again.
  useEffect(() => refreshSharing(environmentId), [environmentId]);
  const nowMs = Date.parse(useNowMinute());
  const [made, setMade] = useState<PeopleLink | null>(null);

  const linksHere = scope === null ? [] : linksOn(links.data?.links ?? [], scope, nowMs);
  // An unused link for someone already listed sits under their row.
  const listedIds = new Set(
    (access.rows ?? []).flatMap((row) => (row.personId === null ? [] : [row.personId])),
  );
  const linkUnder = (personId: string | null) =>
    personId === null
      ? []
      : linksHere.filter((link) => link.use === "one" && link.personId === personId);
  const trailingLinks = linksHere.filter(
    (link) => link.use === "many" || link.personId === null || !listedIds.has(link.personId),
  );

  if (made !== null && scope !== null) {
    return (
      <MadeLink
        environmentId={environmentId}
        link={made}
        scopeTitle={titles.title ?? "it"}
        nowMs={nowMs}
        onBack={() => setMade(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              {titles.project === null ? null : <ProjectFavicon project={titles.project} />}
              <span className="min-w-0 truncate">
                {titles.title === null ? "Share" : `Share ${titles.title}`}
              </span>
            </span>
          </DialogTitle>
          {titles.detail === null ? null : <DialogDescription>{titles.detail}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          {givenScope === null ? (
            <WhatPicker
              environmentId={environmentId}
              value={pickedScope}
              onChange={setPickedScope}
            />
          ) : null}
          {scope === null ? null : (
            <>
              <div className="overflow-hidden rounded-lg border border-border">
                <p className="bg-muted/40 px-2.5 pt-1.5 pb-0.5 text-2xs font-medium text-muted-foreground">
                  Who has it
                </p>
                {access.rows === null ? (
                  <p className="px-2.5 py-2 text-xs text-muted-foreground">
                    {access.error ?? "Reading who reaches it…"}
                  </p>
                ) : (
                  access.rows.map((row, index) => (
                    <AccessRowLine
                      // Someone who is not an Owner is told no ids.
                      key={row.personId ?? index}
                      environmentId={environmentId}
                      scope={scope}
                      row={row}
                      canManage={canManage}
                      unusedLinks={linkUnder(row.personId)}
                      nowMs={nowMs}
                    />
                  ))
                )}
                {trailingLinks.map((link) => (
                  <LinkLine
                    key={link.linkId}
                    environmentId={environmentId}
                    link={link}
                    canManage={canManage}
                    nowMs={nowMs}
                    indent={false}
                    // A link for one person who is not on the server yet names who it is for.
                    label={link.use === "one" ? `${link.personName ?? "One person"} · ` : null}
                  />
                ))}
              </div>
              {canManage ? (
                <AddForm
                  environmentId={environmentId}
                  scope={scope}
                  people={people.data?.people ?? []}
                  reachOf={(personId) =>
                    access.rows?.find((row) => row.personId === personId)?.level ?? null
                  }
                  onMade={setMade}
                  onShared={() => refreshSharing(environmentId)}
                />
              ) : null}
              <Alert>
                <AlertDescription>{historyNote(scope)}</AlertDescription>
              </Alert>
            </>
          )}
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

/**
 * One person who reaches the thing. A level held here gets a control and a remove; one held
 * through a wider scope is shown with that scope and changed there (AC36). The first owner has
 * neither (AC51).
 */
export function AccessRowLine({
  environmentId,
  scope,
  row,
  canManage,
  unusedLinks,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: PersonScope;
  readonly row: AccessRow;
  readonly canManage: boolean;
  readonly unusedLinks: ReadonlyArray<PeopleLink>;
  readonly nowMs: number;
}) {
  const setLevel = useAtomCommand(sharingManage.setLevel, { reportFailure: false });
  const removeLevel = useAtomCommand(sharingManage.removeLevel, { reportFailure: false });
  const [pending, setPending] = useState<PersonLevel | null>(null);
  const [busy, setBusy] = useState(false);
  const name = row.name ?? "Someone without a name yet";
  const controls = canManage && row.personId !== null && row.here !== null && !row.firstOwner;

  const apply = async (level: PersonLevel) => {
    if (row.personId === null) return;
    setBusy(true);
    const result = await setLevel({
      environmentId,
      input: { personId: row.personId, scope, level },
    });
    setBusy(false);
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change the level",
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };
  const choose = (level: PersonLevel) => {
    if (level === row.here) return;
    // Writing is said before it is given (AC35).
    if (raisesToWriting(row.here, level)) setPending(level);
    else void apply(level);
  };
  const remove = async () => {
    if (row.personId === null) return;
    setBusy(true);
    const result = await removeLevel({ environmentId, input: { personId: row.personId, scope } });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not remove ${name}`,
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };

  return (
    <div className="border-t border-border first-of-type:border-t-0">
      <div className="flex min-h-9 items-center gap-2 px-2.5 text-sm">
        <PersonAvatar name={row.name} size="sm" />
        <span className="min-w-0 truncate">{name}</span>
        {row.you ? <span className="shrink-0 text-xs text-muted-foreground">· you</span> : null}
        {row.firstOwner ? (
          <Badge variant="outline" size="sm">
            first owner
          </Badge>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {controls && row.here !== null ? (
            <>
              <LevelSelect
                levels={levelsAt(scope)}
                value={pending ?? row.here}
                disabled={busy}
                label={`Level for ${name}`}
                onChange={choose}
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={busy}
                aria-label={`Remove ${name}`}
                onClick={() => void remove()}
              >
                <XIcon className="size-3.5" />
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {row.here !== null
                ? levelLabel(row.here)
                : row.wider === null
                  ? levelLabel(row.level)
                  : widerLabel(row.wider)}
            </span>
          )}
        </span>
      </div>
      {pending !== null ? (
        <div className="flex flex-col gap-2 px-2.5 pb-2.5">
          <WritingWarning name={row.name} />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button size="xs" disabled={busy} onClick={() => void apply(pending)}>
              Make {levelLabel(pending)}
            </Button>
          </div>
        </div>
      ) : null}
      {unusedLinks.map((link) => (
        <LinkLine
          key={link.linkId}
          environmentId={environmentId}
          link={link}
          canManage={canManage}
          nowMs={nowMs}
          indent
        />
      ))}
    </div>
  );
}

function LevelSelect({
  levels,
  value,
  disabled,
  label,
  onChange,
}: {
  readonly levels: ReadonlyArray<PersonLevel>;
  readonly value: PersonLevel;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (level: PersonLevel) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as PersonLevel)}
    >
      <SelectTrigger size="xs" aria-label={label}>
        <SelectValue>{levelLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {levels.map((level) => (
          <SelectItem hideIndicator key={level} value={level}>
            {levelLabel(level)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The statement of AC37, before anyone is given writing. */
export function WritingWarning({ name }: { readonly name: string | null }) {
  const { lead, rest } = writingWarning(name);
  return (
    <Alert variant="warning">
      <AlertDescription>
        <p>
          <strong className="font-semibold">{lead}</strong> {rest}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** A link in force, with Copy and Revoke until it expires, is revoked or is used (AC41). */
export function LinkLine({
  environmentId,
  link,
  canManage,
  nowMs,
  indent,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeopleLink;
  readonly canManage: boolean;
  readonly nowMs: number;
  readonly indent: boolean;
  /** What the line says before the link's own details; the People page names what it opens. */
  readonly label?: React.ReactNode;
}) {
  const addressFor = useLinkAddress(environmentId);
  const revokeLink = useAtomCommand(sharingManage.revokeLink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "link",
    onCopy: () => toastManager.add({ type: "success", title: "Link copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  if (lifetimeLeft(link.expiresAt.epochMilliseconds, nowMs) === null) return null;
  const address = addressFor(link.token);
  const revoke = async () => {
    setBusy(true);
    const result = await revokeLink({ environmentId, input: { linkId: link.linkId } });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not revoke the link",
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };
  return (
    <div
      className={`flex min-h-8 items-center gap-2 border-t border-border px-2.5 text-xs text-muted-foreground ${indent ? "pl-9" : ""}`}
    >
      <Link2Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {label}
        {linkMeta(link, nowMs)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={address === null}
          onClick={() => (address === null ? undefined : copyToClipboard(address, undefined))}
        >
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canManage || busy}
          onClick={() => void revoke()}
        >
          Revoke
        </Button>
      </span>
    </div>
  );
}

/**
 * Bringing someone in (AC31, AC35, AC40). "Add a person" makes a link for one. For someone
 * already on the server it gives them the level here with no link when that is more than they
 * reach it with, and otherwise makes a link that pairs one more device as them. "Anyone with the
 * link" makes a link for many, at Viewer.
 */
function AddForm({
  environmentId,
  scope,
  people,
  reachOf,
  onMade,
  onShared,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: PersonScope;
  readonly people: ReadonlyArray<PeopleEntry>;
  /** The level someone already reaches the thing with, from anywhere; `null` for none. */
  readonly reachOf: (personId: string) => PersonLevel | null;
  readonly onMade: (link: PeopleLink) => void;
  readonly onShared: () => void;
}) {
  const createLink = useAtomCommand(sharingManage.createLink, { reportFailure: false });
  const setLevel = useAtomCommand(sharingManage.setLevel, { reportFailure: false });
  const [mode, setMode] = useState<AddMode>("person");
  const [name, setName] = useState("");
  const [level, setLevelChoice] = useState<PersonLevel>("viewer");
  const [lifetime, setLifetime] = useState<LinkLifetime>(DEFAULT_LINK_LIFETIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = mode === "person" ? personNamed(people, name) : null;
  const matches = existing === null ? peopleMatching(people, name) : [];
  const typed = name.trim();
  const heldHere = existing?.levels.find((held) => sameScope(held.scope, scope))?.level ?? null;
  // Someone who already reaches the thing at this level gains nothing; the link adds a device.
  const addsDevice = existing !== null && levelReaches(reachOf(existing.personId), level);
  const raises = existing !== null && !addsDevice;
  const warn =
    mode === "person" && !addsDevice && raisesToWriting(existing === null ? null : heldHere, level);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing !== null && raises) {
        const result = await setLevel({
          environmentId,
          input: { personId: existing.personId, scope, level },
        });
        if (result._tag === "Failure") {
          setError(refusalMessage(result));
          return;
        }
        setName("");
        onShared();
        return;
      }
      if (mode === "person" && typed !== "" && !isPersonName(typed)) {
        setError(NAME_NOT_USABLE);
        return;
      }
      const result = await createLink({
        environmentId,
        input:
          existing !== null
            ? { kind: "device", personId: existing.personId, lifetime }
            : mode === "anyone"
              ? { kind: "invite", scope, level: "viewer", use: "many", name: null, lifetime }
              : {
                  kind: "invite",
                  scope,
                  level,
                  use: "one",
                  name: typed === "" ? null : typed,
                  lifetime,
                },
      });
      if (result._tag === "Failure") {
        setError(`The link could not be made. ${refusalMessage(result)}`);
        return;
      }
      onShared();
      onMade(result.value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3">
      <ToggleGroup
        aria-label="Who the link is for"
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "person" || value === "anyone") setMode(value);
          setError(null);
        }}
      >
        <Toggle value="person">Add a person</Toggle>
        <Toggle value="anyone">Anyone with the link</Toggle>
      </ToggleGroup>
      {mode === "person" ? (
        <>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
            <Autocomplete
              items={matches}
              itemToStringValue={(person: PeopleEntry) => person.name ?? ""}
              mode="none"
              value={name}
              onValueChange={(value) => {
                setName(value);
                setError(null);
              }}
            >
              <AutocompleteInput
                placeholder="Their name on this server"
                disabled={busy}
                maxLength={80}
              />
              {matches.length > 0 ? (
                <AutocompletePopup>
                  <AutocompleteList>
                    {matches.map((person) => (
                      <AutocompleteItem key={person.personId} value={person}>
                        <span className="min-w-0 truncate">{person.name}</span>
                        <span className="text-xs text-muted-foreground">
                          Already on this server
                        </span>
                      </AutocompleteItem>
                    ))}
                  </AutocompleteList>
                </AutocompletePopup>
              ) : null}
            </Autocomplete>
          </label>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-foreground">Level</p>
            <div className="w-36 shrink-0">
              <LevelSelect
                levels={levelsAt(scope)}
                value={level}
                disabled={busy}
                label="Level"
                onChange={setLevelChoice}
              />
            </div>
          </div>
          {raises ? (
            <p className="text-xs text-muted-foreground">
              {existing.name} is already on this server, so no link is needed.
            </p>
          ) : (
            <LinkLifetimeRow
              value={lifetime}
              onChange={setLifetime}
              helper={
                addsDevice
                  ? `${existing.name} already reaches this. The link pairs one more device as them.`
                  : "One use, one device."
              }
              disabled={busy}
            />
          )}
          {warn ? <WritingWarning name={existing?.name ?? (typed === "" ? null : typed)} /> : null}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-foreground">Level</p>
            <p className="text-xs text-muted-foreground">Viewer</p>
          </div>
          <LinkLifetimeRow
            value={lifetime}
            onChange={setLifetime}
            helper="Anyone who opens it joins; nobody new after that."
            disabled={busy}
          />
        </>
      )}
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {raises ? (busy ? "Sharing…" : "Share") : busy ? "Making link…" : "Make link"}
        </Button>
      </div>
    </div>
  );
}

/** The link just made, with its route, address and code to send (design §1, "After Make link"). */
function MadeLink({
  environmentId,
  link,
  scopeTitle,
  nowMs,
  onBack,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeopleLink;
  readonly scopeTitle: string;
  readonly nowMs: number;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const left = lifetimeLeft(link.expiresAt.epochMilliseconds, nowMs) ?? "moments";
  const level = link.level === null ? null : levelLabel(link.level);
  const person = link.personName;
  const title =
    link.use === "many"
      ? "Link for anyone"
      : person === null
        ? "Link for one person"
        : `Link for ${person}`;
  const description =
    link.use === "many"
      ? `Anyone who opens it joins as a Viewer of ${scopeTitle} until it expires in ${left}.`
      : link.kind === "device"
        ? `Open it on the device to add. It pairs one more device as ${person ?? "them"}, and expires in ${left}.`
        : `Send it to ${person ?? "them"}. Opening it pairs one device as them. ${level ?? "Access"} on ${scopeTitle}, expires in ${left}.`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {link.use === "one" && link.level !== null && raisesToWriting(null, link.level) ? (
            <WritingWarning name={person} />
          ) : null}
          <ShareLinkPanel
            environmentId={environmentId}
            token={link.token}
            whoCannotOpen={link.use === "many" ? "People" : (person ?? "They")}
            meta={null}
          />
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
