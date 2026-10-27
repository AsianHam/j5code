import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  introducePeers,
  introducePollingPeer,
  peerOriginWarning,
  peeringChoiceReady,
  peeringLines,
  peeringRecords,
  peeringStepTitle,
  pollPeeringStepTitle,
  recommendPeering,
  type PeeringChoice,
  type PeeringQuestion,
  type PeeringRecommendation,
  type PeeringReach,
  type PeeringServer,
  type PeeringSide,
} from "@t3tools/client-runtime/j5/peering";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  useEnvironments,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { j5Environment, peersQueryAtom } from "../state";
import {
  noRouteMessage,
  peeringServerOf,
  runPeeringCheck,
  type PeeringCheck,
} from "./peeringCheck";
import { addPeer, issuePeerCredential, removePeer } from "./peeringClient";

/** Where "How does this work?" goes: the explainer for sending directly and polling. */
export const EXPLAINER_URL = "https://j5.codes/peering";

export interface StepReport {
  readonly title: string;
  readonly status: "done" | "failed" | "skipped";
  readonly detail: string | null;
}

/**
 * The introduction between any two servers this client is connected to; the first is one it
 * manages. Each server tests the direction it would connect in, so the dialog asks only what that
 * check could not settle. A server too old for poll mode gets only "update J5 there". A pair the
 * first server already records is removed before peering again; a stale one on the other, cleared.
 */
export function PeerIntroductionDialog({
  open,
  onOpenChange,
  servers,
  defaultServerId,
  onPeered,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The connected servers this client manages, any of which can be the first of the pair. */
  readonly servers: ReadonlyArray<EnvironmentId>;
  readonly defaultServerId: EnvironmentId;
  readonly onPeered: (first: EnvironmentId, second: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const [thisServerId, setThisServerId] = useState(defaultServerId);
  const thisServer = useEnvironment(thisServerId);
  const [otherId, setOtherId] = useState<EnvironmentId | null>(null);
  const thisServerBaseUrl = useEnvironmentHttpBaseUrl(thisServerId);
  const otherBaseUrl = useEnvironmentHttpBaseUrl(otherId);
  const otherCanWriteAccess = useAtomValue(j5Environment.addPeer.permissionAtom(otherId));
  const candidates = environments
    .filter((environment) => environment.environmentId !== thisServerId)
    .toSorted((left, right) => left.label.localeCompare(right.label));
  const other = candidates.find((environment) => environment.environmentId === otherId) ?? null;

  const local = thisServer === null ? null : peeringServerOf(thisServer);
  const remote = other === null ? null : peeringServerOf(other);
  const otherReady =
    other !== null && other.connection.phase === "connected" && otherCanWriteAccess;
  const bothSupportPoll = local?.supportsPoll === true && remote?.supportsPoll === true;
  // Whether each server supports poll mode is known only once its descriptor is.
  const described =
    (thisServer?.serverConfig ?? null) !== null && (other?.serverConfig ?? null) !== null;

  // Each server's record of the other. One here is a peering this server still
  // holds: it is removed under Peer servers first. One held only by the other
  // server is a leftover, such as from a removal made on this side only.
  const otherConnected = other !== null && other.connection.phase === "connected";
  // Both are read while the remote is connected, even unmanaged, so a leftover can name where to clear it.
  const localPeers = useEnvironmentQuery(otherConnected ? peersQueryAtom(thisServerId) : null);
  const remotePeers = useEnvironmentQuery(
    otherConnected && otherId !== null ? peersQueryAtom(otherId) : null,
  );
  // A list that failed to read says nothing about what that server records, so nothing is decided from it.
  const herePeers = localPeers.error === null ? localPeers.data : null;
  const therePeers = remotePeers.error === null ? remotePeers.data : null;
  const recordsRead = otherReady && herePeers !== null && therePeers !== null;
  const { heldHere, leftover } =
    herePeers !== null && therePeers !== null
      ? peeringRecords({
          thisServer: thisServerId,
          otherServer: otherId ?? "",
          here: herePeers,
          there: therePeers,
        })
      : { heldHere: false, leftover: false };
  const recordsError =
    localPeers.error !== null
      ? { server: local?.label ?? thisServerId, error: localPeers.error }
      : remotePeers.error !== null
        ? { server: remote?.label ?? otherId, error: remotePeers.error }
        : null;

  // The check's result, kept with the pair it was run for.
  const [checked, setChecked] = useState<{
    readonly key: string;
    readonly result: PeeringCheck;
  } | null>(null);
  const [manual, setManual] = useState<PeeringChoice | null>(null);
  const [answer, setAnswer] = useState<"store" | "direct">("store");
  const [originEdits, setOriginEdits] = useState<Partial<PeeringChoice>>({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReadonlyArray<StepReport> | null>(null);

  const chooseOther = (value: EnvironmentId | null) => {
    setOtherId(value);
    setManual(null);
    setAnswer("store");
    setOriginEdits({});
    setReport(null);
  };
  const chooseServer = (value: EnvironmentId) => {
    setThisServerId(value);
    chooseOther(otherId === value ? null : otherId);
  };

  // The check runs once the remote can be managed, both servers support it, and
  // this server does not already record it.
  const checkKey =
    local !== null && remote !== null && recordsRead && !heldHere && bothSupportPoll
      ? `${local.environmentId}|${remote.environmentId}`
      : null;
  // oxlint-disable-next-line t3code/react-effect-budget -- runs the peering check against both servers whenever the pair changes, and drops a stale answer.
  useEffect(() => {
    if (checkKey === null || local === null || remote === null) return;
    let cancelled = false;
    void runPeeringCheck(
      { server: local, clientUrl: thisServerBaseUrl },
      { server: remote, clientUrl: otherBaseUrl },
    ).then((result) => {
      if (!cancelled) setChecked({ key: checkKey, result });
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Keyed on the pair and its addresses: the server objects are rebuilt on every environment refresh.
  }, [checkKey, thisServerBaseUrl, otherBaseUrl]);
  const check = checked !== null && checked.key === checkKey ? checked.result : null;

  const recommendation: PeeringRecommendation | null =
    local === null || remote === null || !described || (otherReady && !recordsRead) || heldHere
      ? null
      : !bothSupportPoll
        ? recommendPeering({
            local,
            remote,
            localToRemote: { kind: "untested", error: null },
            remoteToLocal: { kind: "untested", error: null },
          })
        : check === null
          ? null
          : recommendPeering({ local, remote, ...check });

  const question =
    recommendation?.kind === "setup" && manual === null ? recommendation.question : null;
  const recommended =
    recommendation?.kind === "setup"
      ? question === null
        ? recommendation.choice
        : answer === "direct"
          ? question.directChoice
          : question.storeChoice
      : null;
  const choice: PeeringChoice | null =
    manual ?? (recommended === null ? null : { ...recommended, ...originEdits });
  // Peering needs the remote manageable, both records read and no record of it here,
  // whichever setup is chosen: a saved manual one outlives any of them changing.
  const peerable = otherReady && recordsRead && !heldHere;
  const ready = peerable && choice !== null && peeringChoiceReady(choice) && !busy;

  const peer = async () => {
    if (!peerable || choice === null || local === null || remote === null) return;
    const introduce = async () => {
      // An old record of this server on the other one is cleared first, so the pairing starts clean.
      const cleared: Array<StepReport> = [];
      if (leftover) {
        const title = `Clear ${remote.label}'s old record of ${local.label}`;
        try {
          await removePeer(remote.environmentId, local.environmentId);
          cleared.push({ title, status: "done", detail: null });
        } catch (cause) {
          setReport([
            {
              title,
              status: "failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          ]);
          return;
        }
      }
      const localSide: PeeringSide = {
        environmentId: local.environmentId,
        label: local.label,
        origin: choice.localOrigin.trim(),
      };
      const remoteSide: PeeringSide = {
        environmentId: remote.environmentId,
        label: remote.label,
        origin: choice.remoteOrigin.trim(),
      };
      let ok: boolean;
      if (choice.connections === "both") {
        const outcome = await introducePeers({
          local: localSide,
          remote: remoteSide,
          issue: (issuer, holder) =>
            issuePeerCredential(issuer.environmentId, {
              environmentId: holder.environmentId,
              label: holder.label,
            }),
          record: (recorder, target, credential) =>
            addPeer(recorder.environmentId, { origin: target.origin, credential }),
        });
        ok = outcome.ok;
        setReport([
          ...cleared,
          ...outcome.steps.map((step) => ({
            title: peeringStepTitle(step.step, localSide, remoteSide),
            status: step.status,
            detail: step.detail,
          })),
        ]);
      } else {
        const [poller, storer] =
          choice.connections === "local-only" ? [localSide, remoteSide] : [remoteSide, localSide];
        const outcome = await introducePollingPeer({
          poller,
          storer,
          issue: (issuer, holder) =>
            issuePeerCredential(issuer.environmentId, {
              environmentId: holder.environmentId,
              label: holder.label,
              store: true,
            }),
          record: (recorder, target, credential) =>
            addPeer(recorder.environmentId, { origin: target.origin, credential, poll: true }),
        });
        ok = outcome.ok;
        setReport([
          ...cleared,
          ...outcome.steps.map((step) => ({
            title: pollPeeringStepTitle(step.step, poller, storer),
            status: step.status,
            detail: step.detail,
          })),
        ]);
      }
      if (ok) {
        onPeered(local.environmentId, remote.environmentId);
        onOpenChange(false);
      }
    };
    setBusy(true);
    setReport(null);
    await introduce().finally(() => setBusy(false));
  };

  const tooOld = recommendation?.kind === "too-old" ? recommendation.server : null;

  return (
    <Dialog
      open={open}
      // Escape, the backdrop and the close button wait like Cancel does: a run in
      // flight reports into this dialog, and closing it would lose that report.
      onOpenChange={(next) => {
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Peer with another server</DialogTitle>
          <DialogDescription>
            {manual === null
              ? "Each server records the other so their agents can message each other."
              : "Choose how A2A messages travel between the two servers."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                Server
                <Select
                  disabled={busy}
                  value={thisServerId}
                  onValueChange={(value) => {
                    if (value !== null) chooseServer(value as EnvironmentId);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Server to peer">
                    <SelectValue>{local?.label ?? thisServerId}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {servers.map((id) => (
                      <SelectItem key={id} value={id}>
                        {environments.find((environment) => environment.environmentId === id)
                          ?.label ?? id}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                Peer with
                <Select
                  disabled={busy}
                  value={otherId ?? undefined}
                  onValueChange={(value) => chooseOther((value as EnvironmentId | null) ?? null)}
                >
                  <SelectTrigger className="w-full" aria-label="Server to peer with">
                    <SelectValue>{remote?.label ?? "Choose a server"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {candidates.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {candidates.length === 0 ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    Add another environment under Environments first.
                  </span>
                ) : null}
              </label>
            </div>

            {other !== null && !otherReady ? (
              <p className="text-xs text-muted-foreground">
                {other.connection.phase !== "connected"
                  ? `Connect to ${other.label} first; peering needs both servers reachable from this browser.`
                  : `This connection to ${other.label} cannot manage access (it lacks access:write), so it cannot issue a peer credential there.`}
              </p>
            ) : null}

            {tooOld !== null && local !== null ? (
              <Alert variant="error">
                <AlertTitle>
                  {tooOld.label} is running J5 {tooOld.serverVersion}, which is too old to peer with{" "}
                  {tooOld.environmentId === local.environmentId ? remote?.label : local.label}.
                </AlertTitle>
                <AlertDescription>Update J5 on {tooOld.label}, then try again.</AlertDescription>
              </Alert>
            ) : null}

            {recordsError !== null ? (
              <p className="text-xs text-destructive">
                Could not read {recordsError.server}'s peers: {recordsError.error}
              </p>
            ) : null}

            {heldHere && remote !== null && local !== null ? (
              <p className="text-xs text-muted-foreground">
                {remote.label} is already a peer of {local.label}. Remove that peering under Peer
                servers first, then peer them again.
              </p>
            ) : leftover && remote !== null && local !== null ? (
              <p className="text-xs text-muted-foreground">
                {remote.label} still has an old record of {local.label}.{" "}
                {otherReady
                  ? "Peering clears it there first."
                  : `Remove ${local.label} under Peer servers on ${remote.label} first.`}
              </p>
            ) : null}

            {otherReady &&
            bothSupportPoll &&
            !heldHere &&
            local !== null &&
            remote !== null &&
            manual === null ? (
              <CheckCard local={local} remote={remote} check={check} question={question} />
            ) : null}

            {recommendation?.kind === "no-route" && check !== null && manual === null ? (
              <p className="text-xs text-muted-foreground">{noRouteMessage(check)}</p>
            ) : null}

            {question !== null && local !== null && remote !== null ? (
              <ConnectionQuestion
                question={question}
                local={local}
                remote={remote}
                answer={answer}
                onAnswer={setAnswer}
                disabled={busy}
              />
            ) : null}

            {manual !== null && local !== null && remote !== null ? (
              <ManualForm
                choice={manual}
                local={local}
                remote={remote}
                onChange={setManual}
                disabled={busy}
              />
            ) : null}

            {choice !== null && local !== null && remote !== null ? (
              <Alert variant="info">
                <AlertTitle>How messages will travel</AlertTitle>
                <AlertDescription>
                  <ul className="space-y-1 text-foreground">
                    {peeringLines(choice, local, remote).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {manual === null && choice !== null && local !== null && remote !== null ? (
              <UsedAddress
                choice={choice}
                local={local}
                remote={remote}
                question={question}
                answer={answer}
                onChange={(edit) => setOriginEdits((edits) => ({ ...edits, ...edit }))}
                disabled={busy}
              />
            ) : null}

            {report !== null ? <StepList steps={report} /> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <a
            href={EXPLAINER_URL}
            target="_blank"
            rel="noreferrer"
            className="mr-auto self-center text-xs text-primary hover:underline"
          >
            How does this work?
          </a>
          {tooOld !== null ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              {manual !== null ? (
                <Button variant="ghost" disabled={busy} onClick={() => setManual(null)}>
                  Back to the recommended setup
                </Button>
              ) : recommendation !== null && local !== null && remote !== null ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setManual(choice ?? { connections: "both", localOrigin: "", remoteOrigin: "" })
                  }
                >
                  Set up differently
                </Button>
              ) : (
                <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              )}
              <Button disabled={!ready} onClick={() => void peer()}>
                {busy ? "Peering…" : "Peer"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** What the check found in each direction, with each probe's own error, and how each server is run. */
function CheckCard({
  local,
  remote,
  check,
  question,
}: {
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  readonly check: PeeringCheck | null;
  readonly question: PeeringQuestion | null;
}) {
  if (check === null) {
    return (
      <Alert>
        <AlertTitle>
          Checking how {local.label} and {remote.label} reach each other…
        </AlertTitle>
      </Alert>
    );
  }
  const asked =
    question !== null && question.reason !== "untested"
      ? question.toward === "local"
        ? local
        : remote
      : null;
  const bothReach =
    check.localToRemote.kind === "reached" && check.remoteToLocal.kind === "reached";
  return (
    <Alert variant={!bothReach ? "warning" : asked === null ? "success" : "default"}>
      <AlertDescription>
        <ul className="space-y-1.5">
          <ReachLine from={local} to={remote} reach={check.localToRemote} />
          <ReachLine from={remote} to={local} reach={check.remoteToLocal} />
          {asked !== null ? (
            <li>
              <span className="text-foreground">
                {asked.label}{" "}
                {asked.runMode === "desktop"
                  ? "runs J5 in the desktop app"
                  : "runs J5 started by hand, not as a service"}
              </span>
              <span className="block text-xs">
                {asked.runMode === "desktop"
                  ? "It's offline whenever the app is closed or the device sleeps."
                  : "It may not stay on."}
              </span>
            </li>
          ) : bothReach && local.runMode === "service" && remote.runMode === "service" ? (
            <li className="text-foreground">Both run as always-on services</li>
          ) : null}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function ReachLine({
  from,
  to,
  reach,
}: {
  readonly from: Pick<PeeringServer, "label">;
  readonly to: Pick<PeeringServer, "label">;
  readonly reach: PeeringReach;
}) {
  switch (reach.kind) {
    case "reached":
      return (
        <li>
          <span className="text-foreground">
            ✓ {from.label} reaches {to.label}
          </span>
          <span className="block text-xs">at {reach.origin}</span>
        </li>
      );
    case "failed":
      return (
        <li>
          <span className="text-foreground">
            ✕ {from.label} can't reach {to.label}
          </span>
          {reach.errors.map((error) => (
            <span key={error} className="block font-mono text-xs">
              {error}
            </span>
          ))}
        </li>
      );
    case "untested":
      return (
        <li>
          <span className="text-foreground">
            ? Couldn't test {from.label} reaching {to.label}
          </span>
          <span className="block text-xs">
            {reach.error === null
              ? `${to.label} only knows loopback addresses for itself`
              : `${to.label} could not list its addresses: ${reach.error}`}
          </span>
        </li>
      );
  }
}

/** The connection method itself, for the one direction the check could not settle. */
function ConnectionQuestion({
  question,
  local,
  remote,
  answer,
  onAnswer,
  disabled,
}: {
  readonly question: PeeringQuestion;
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  readonly answer: "store" | "direct";
  readonly onAnswer: (answer: "store" | "direct") => void;
  readonly disabled: boolean;
}) {
  const [receiver, sender] = question.toward === "local" ? [local, remote] : [remote, local];
  const options = [
    {
      value: "direct" as const,
      title: "Send them directly",
      detail:
        question.reason === "untested"
          ? `Only if ${receiver.label} is always on and ${sender.label} can open connections to it, for example over Tailscale. You'll enter the address below.`
          : `Choose this if ${receiver.label} is always on and the app stays open. Messages sent while it's off aren't delivered: they fail after a few quick retries.`,
    },
    {
      value: "store" as const,
      title: `Store them until ${receiver.label} polls`,
      detail:
        question.reason === "untested"
          ? "Works on any network, including behind an office firewall."
          : `${sender.label} keeps them and ${receiver.label} picks them up when it's next on. Safe if you're not sure.`,
    },
  ];
  return (
    <div className="space-y-2">
      <p id="peering-question" className="text-sm font-medium text-foreground">
        How should {sender.label} get A2A messages to {receiver.label}?
      </p>
      <RadioGroup
        value={answer}
        onValueChange={(value) => onAnswer(value === "direct" ? "direct" : "store")}
        aria-labelledby="peering-question"
        disabled={disabled}
      >
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2 text-sm"
          >
            <Radio value={option.value} className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{option.title}</span>
              <span className="text-xs text-muted-foreground">{option.detail}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

/** Only the address that will be used: the one a poller polls at, or one the check could not prove. */
function UsedAddress({
  choice,
  local,
  remote,
  question,
  answer,
  onChange,
  disabled,
}: {
  readonly choice: PeeringChoice;
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  readonly question: PeeringQuestion | null;
  readonly answer: "store" | "direct";
  readonly onChange: (edit: Partial<PeeringChoice>) => void;
  readonly disabled: boolean;
}) {
  if (choice.connections === "both") {
    if (question === null || !question.directNeedsAddress || answer !== "direct") return null;
    const [to, from] = question.toward === "local" ? [local, remote] : [remote, local];
    const field = question.toward === "local" ? "localOrigin" : "remoteOrigin";
    return (
      <OriginField
        title={`${from.label} reaches ${to.label} at`}
        value={choice[field]}
        onChange={(value) => onChange({ [field]: value })}
        disabled={disabled}
      />
    );
  }
  const [poller, storer, field] =
    choice.connections === "local-only"
      ? [local, remote, "remoteOrigin" as const]
      : [remote, local, "localOrigin" as const];
  return (
    <OriginField
      title={`${poller.label} reaches ${storer.label} at`}
      value={choice[field]}
      onChange={(value) => onChange({ [field]: value })}
      disabled={disabled}
    />
  );
}

/** "Set up differently": which way connections can go, and an address for each side that can be reached. */
function ManualForm({
  choice,
  local,
  remote,
  onChange,
  disabled,
}: {
  readonly choice: PeeringChoice;
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  readonly onChange: (choice: PeeringChoice) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p id="peering-connections" className="text-sm font-medium text-foreground">
          Which way can connections go?
        </p>
        <ToggleGroup
          aria-labelledby="peering-connections"
          className="w-full *:flex-1"
          value={[choice.connections]}
          disabled={disabled}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "both" || value === "local-only" || value === "remote-only") {
              onChange({ ...choice, connections: value });
            }
          }}
        >
          <Toggle value="both">Both ways</Toggle>
          <Toggle value="local-only">
            {local.label} → {remote.label} only
          </Toggle>
          <Toggle value="remote-only">
            {remote.label} → {local.label} only
          </Toggle>
        </ToggleGroup>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">{local.label}</legend>
          {choice.connections === "remote-only" ? (
            <p className="text-xs text-muted-foreground">
              Stores messages for {remote.label} and waits to be polled.
            </p>
          ) : (
            <OriginField
              title={`Reaches ${remote.label} at`}
              value={choice.remoteOrigin}
              onChange={(value) => onChange({ ...choice, remoteOrigin: value })}
              disabled={disabled}
            />
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">{remote.label}</legend>
          {choice.connections === "local-only" ? (
            <p className="text-xs text-muted-foreground">
              Stores messages for {local.label} and waits to be polled.
            </p>
          ) : (
            <OriginField
              title={`Reaches ${local.label} at`}
              value={choice.localOrigin}
              onChange={(value) => onChange({ ...choice, localOrigin: value })}
              disabled={disabled}
            />
          )}
        </fieldset>
      </div>
    </div>
  );
}

export function OriginField({
  title,
  value,
  onChange,
  disabled,
}: {
  readonly title: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const warning = peerOriginWarning(value);
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
      {title}
      <Input
        nativeInput
        value={value}
        disabled={disabled}
        placeholder="https://host:3773"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {warning !== null ? (
        <span className="text-xs font-normal text-warning-foreground">{warning}</span>
      ) : null}
    </label>
  );
}

export function StepList({ steps }: { readonly steps: ReadonlyArray<StepReport> }) {
  const failedAfterIssuing =
    steps.some((step) => step.status === "failed") &&
    steps.some((step) => step.status === "done" && step.title.startsWith("Issue"));
  return (
    <ol className="space-y-1 text-xs">
      {steps.map((step) => (
        <li key={step.title} className="flex flex-col">
          <span
            className={
              step.status === "failed"
                ? "text-destructive"
                : step.status === "skipped"
                  ? "text-muted-foreground/60"
                  : "text-foreground"
            }
          >
            {step.status === "done" ? "Done" : step.status === "failed" ? "Failed" : "Skipped"}
            {": "}
            {step.title}
          </span>
          {step.detail !== null ? (
            <span className="text-muted-foreground">{step.detail}</span>
          ) : null}
        </li>
      ))}
      {failedAfterIssuing ? (
        <li className="text-muted-foreground">
          Nothing was undone. The existing peering, if any, still works. Credentials issued in this
          attempt stay listed under Connections on the server that issued them until a later peering
          replaces them, or you revoke them there.
        </li>
      ) : null}
    </ol>
  );
}
