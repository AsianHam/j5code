import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  SharingGrantLevel,
  SharingGrantTarget,
  SharingLink,
  SharingPerson,
} from "@t3tools/contracts/j5";
import { isPersonName } from "@t3tools/contracts/j5";
import { useEffect, useState } from "react";

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
import { Input } from "../../components/ui/input";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinkLifetimeRow } from "./LinkLifetimeRow";
import {
  DEFAULT_LINK_LIFETIME,
  guestsMatchingName,
  levelLabel,
  NAME_NOT_USABLE,
  namedLinkMeta,
  type LinkLifetime,
} from "./shareLink.logic";
import { ShareLinkPanel } from "./ShareLinkPanel";
import { TargetPicker } from "./TargetPicker";
import {
  peopleQuery,
  refreshSharing,
  refusalMessage,
  rememberLinkSecret,
  sharingManage,
} from "./sharingManage";

/**
 * Whether a guest can be given Collaborate yet. Nothing lets a guest send to an agent today, so
 * the level is listed and cannot be chosen; the fields and the warning that go with it are built
 * and appear once it can.
 */
const COLLABORATE_IS_OFFERED = false;

const LEVELS: ReadonlyArray<{
  readonly level: SharingGrantLevel;
  readonly description: string;
}> = [
  {
    level: "view",
    // The design's line also promised the right panel's diffs and the in-app browser, which a
    // guest is not served today; this says what a View guest can read now.
    description:
      "Read the conversation and the changes each turn made. Cannot send anything to the agent.",
  },
  {
    level: "collaborate",
    description: "Also message the agent, answer its prompts and drive the in-app browser.",
  },
];

/** The thread's or project's title, as the person sharing it knows it. */
export function useTargetTitle(
  environmentId: EnvironmentId,
  target: SharingGrantTarget | null,
): string | null {
  const thread = useThreadShell(
    target?.kind === "thread" ? scopeThreadRef(environmentId, target.threadId) : null,
  );
  const project = useProject(
    target?.kind === "project" ? scopeProjectRef(environmentId, target.projectId) : null,
  );
  return target?.kind === "thread" ? (thread?.title ?? null) : (project?.title ?? null);
}

/**
 * Sharing a thread or a project with one person (Shared server AC18 to AC22). A new person gets
 * a link, shown as the dialog's last step; someone already on the server gets the access and no
 * link. What sharing gives away is said before the member confirms.
 */
export function ShareDialog({
  environmentId,
  target: givenTarget,
  person: givenPerson,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** `null` when the dialog was opened from the People page: it asks what to share. */
  readonly target: SharingGrantTarget | null;
  /** Someone already on the server who is being given more access. */
  readonly person?: { readonly personId: string; readonly name: string } | undefined;
  readonly onClose: () => void;
}) {
  const [pickedTarget, setPickedTarget] = useState<SharingGrantTarget | null>(null);
  const target = givenTarget ?? pickedTarget;
  const targetTitle = useTargetTitle(environmentId, target);
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const people = useEnvironmentQuery(canManage ? peopleQuery(environmentId) : null);
  // People join and leave without this client doing anything, so each opening reads them again.
  useEffect(() => refreshSharing(environmentId), [environmentId]);
  const createGuest = useAtomCommand(sharingManage.createGuest, { reportFailure: false });
  const putGrant = useAtomCommand(sharingManage.putGrant, { reportFailure: false });
  const createLink = useAtomCommand(sharingManage.createLink, { reportFailure: false });

  const [name, setName] = useState(givenPerson?.name ?? "");
  // Someone already on the server, picked from the names that match what was typed.
  const [pickedPerson, setPickedPerson] = useState<SharingPerson | null>(null);
  const existing = givenPerson ?? pickedPerson;
  // A person this dialog made whose grant or link then failed: a second try reuses them.
  const [made, setMade] = useState<SharingPerson | null>(null);
  const [level, setLevel] = useState<SharingGrantLevel>("view");
  const [note, setNote] = useState("");
  const [lifetime, setLifetime] = useState<LinkLifetime>(DEFAULT_LINK_LIFETIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<SharingLink | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const typedName = name.trim();
  const matches = guestsMatchingName(people.data?.people ?? [], name);
  const noun = target === null ? "thread or project" : target.kind;

  const makeLink = async (personId: string) => {
    const created = await createLink({ environmentId, input: { personId, lifetime } });
    if (created._tag === "Failure") {
      setError(`The link could not be made. ${refusalMessage(created)}`);
      return;
    }
    rememberLinkSecret(created.value.linkId, created.value.credential);
    setNowMs(Date.now());
    setLink(created.value);
  };

  const share = async () => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      let person: { readonly personId: string } | null = existing ?? made;
      if (person === null) {
        // The contract refuses such a name before the server sees it, with no words for a person.
        if (!isPersonName(typedName)) {
          setError(NAME_NOT_USABLE);
          return;
        }
        const guest = await createGuest({ environmentId, input: { displayName: typedName } });
        if (guest._tag === "Failure") {
          setError(refusalMessage(guest));
          return;
        }
        person = guest.value;
        setMade(guest.value);
      }
      const granted = await putGrant({
        environmentId,
        input: {
          personId: person.personId,
          target,
          level,
          ...(level === "collaborate" && note.trim() !== "" ? { note: note.trim() } : {}),
        },
      });
      if (granted._tag === "Failure") {
        setError(`The ${noun} could not be shared. ${refusalMessage(granted)}`);
        return;
      }
      if (existing !== null) {
        onClose();
        return;
      }
      await makeLink(person.personId);
    } finally {
      refreshSharing(environmentId);
      setBusy(false);
    }
  };

  const anotherDeviceLink = async () => {
    if (link === null) return;
    setBusy(true);
    setError(null);
    try {
      await makeLink(link.personId);
    } finally {
      refreshSharing(environmentId);
      setBusy(false);
    }
  };

  if (link !== null) {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link for {typedName}</DialogTitle>
            <DialogDescription>
              Send this to {typedName} over a channel you trust. Whoever opens it becomes{" "}
              {typedName} on this server, on that one device.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ShareLinkPanel
              key={link.linkId}
              environmentId={environmentId}
              secret={link.credential}
              kind="named"
              whoCannotOpen={typedName}
              meta={namedLinkMeta({
                expiresAtMs: link.expiresAt.epochMilliseconds,
                nowMs,
                level,
                targetTitle,
              })}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" disabled={busy} onClick={() => void anotherDeviceLink()}>
              {busy ? "Making link…" : "New device link"}
            </Button>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{givenTarget === null ? "Share" : `Share ${givenTarget.kind}`}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {givenTarget === null ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-foreground">Thread or project</p>
              <TargetPicker
                environmentId={environmentId}
                onPick={setPickedTarget}
                disabled={busy || made !== null}
              />
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
            <Autocomplete
              items={matches}
              itemToStringValue={(person: SharingPerson) => person.displayName ?? ""}
              mode="none"
              value={name}
              onValueChange={(value, details) => {
                setName(value);
                setError(null);
                setPickedPerson(
                  details.reason === "item-press"
                    ? (matches.find((person) => person.displayName === value) ?? null)
                    : null,
                );
              }}
            >
              <AutocompleteInput
                autoFocus={givenTarget !== null}
                placeholder="What the agent and other people call them"
                disabled={busy || made !== null || givenPerson !== undefined}
                maxLength={80}
              />
              {matches.length > 0 && existing === null ? (
                <AutocompletePopup>
                  <AutocompleteList>
                    {matches.map((person) => (
                      <AutocompleteItem key={person.personId} value={person}>
                        <span className="min-w-0 truncate">{person.displayName}</span>
                        <span className="text-xs text-muted-foreground">Already a guest here</span>
                      </AutocompleteItem>
                    ))}
                  </AutocompleteList>
                </AutocompletePopup>
              ) : null}
            </Autocomplete>
          </label>
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-foreground">What they can do</h3>
            <div className="rounded-lg border border-input bg-muted/25 px-3 py-2.5">
              <RadioGroup
                value={level}
                disabled={busy}
                onValueChange={(value) => setLevel(value as SharingGrantLevel)}
              >
                {LEVELS.map((option) => {
                  const unavailable = option.level === "collaborate" && !COLLABORATE_IS_OFFERED;
                  return (
                    <label
                      key={option.level}
                      className={
                        unavailable
                          ? "flex items-start gap-3 opacity-64"
                          : "flex cursor-pointer items-start gap-3"
                      }
                    >
                      <Radio className="mt-0.5" value={option.level} disabled={unavailable} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                          {levelLabel(option.level)}
                          {unavailable ? (
                            <Badge variant="outline" size="sm">
                              coming soon
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            </div>
          </section>
          {level === "collaborate" ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                What they are here for{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. reviewing the migration plan with me"
                disabled={busy}
                maxLength={280}
              />
              <span className="mt-1.5 block text-xs text-muted-foreground">
                The agent is told this. It can shape how the agent responds to your guest.
              </span>
            </label>
          ) : null}
          {level === "collaborate" ? (
            <Alert variant="warning">
              <AlertDescription>
                <p>
                  <strong className="font-semibold">
                    You are inviting {typedName === "" ? "them" : typedName} to talk to and control
                    an AI agent on your device.
                  </strong>{" "}
                  Make sure you trust them. Anything the agent can do,{" "}
                  {typedName === "" ? "they" : typedName} can ask it to do.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          <Alert>
            <AlertDescription>
              {target?.kind === "project"
                ? "Sharing a project shares every thread in it and its artifacts, including any agents they spawned."
                : "Sharing a thread shares the agent's whole history, including any agents it spawned."}
            </AlertDescription>
          </Alert>
          {existing === null ? (
            <LinkLifetimeRow
              value={lifetime}
              onChange={setLifetime}
              helper="It works once, on one device."
              disabled={busy}
            />
          ) : null}
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              This connection cannot manage access on this server.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !canManage || typedName === "" || target === null}
            onClick={() => void share()}
          >
            {existing !== null
              ? busy
                ? "Sharing…"
                : "Share"
              : busy
                ? "Making link…"
                : "Make link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
