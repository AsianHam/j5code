import type { EnvironmentId } from "@t3tools/contracts";
import { PeerOrigin } from "@t3tools/contracts/j5";
import {
  peeringLines,
  type PeeringChoice,
  type PeeringReach,
} from "@t3tools/client-runtime/j5/peering";
import * as Schema from "effect/Schema";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import {
  EXPLAINER_URL,
  OriginField,
  ReachLine,
  StepList,
  type StepReport,
} from "./PeerIntroductionDialog";
import { runReachCheck } from "./peeringCheck";
import { changePeerOrigin, refreshPeers, type PeerRecord } from "./peeringClient";
import type { PeerPair, PeerPairSide } from "./peerPairs";

const isPeerOrigin = Schema.is(PeerOrigin);
const cleanOrigin = (origin: string) => origin.trim().replace(/\/+$/, "");

/** A side whose record reaches the other server at an address this client can change. */
export type EditableSide = PeerPairSide & { readonly record: PeerRecord & { origin: string } };

export const editableSides = (pair: PeerPair): ReadonlyArray<EditableSide> =>
  pair.sides.filter(
    (side): side is EditableSide =>
      side.managed &&
      side.record !== null &&
      side.record.linkMode !== "store" &&
      side.record.origin !== null,
  );

/** How the pair travels, in the pairing screen's terms, from whichever side was read. */
const choiceOf = (pair: PeerPair, origins: ReadonlyMap<string, string>): PeeringChoice => {
  const [local, remote] = pair.sides;
  const localRecord = local.record;
  const connections =
    localRecord !== null
      ? localRecord.linkMode === "push"
        ? "both"
        : localRecord.linkMode === "poll"
          ? "local-only"
          : "remote-only"
      : remote.record?.linkMode === "poll"
        ? "remote-only"
        : remote.record?.linkMode === "store"
          ? "local-only"
          : "both";
  return {
    connections,
    remoteOrigin: origins.get(local.environmentId) ?? local.record?.origin ?? "",
    localOrigin: origins.get(remote.environmentId) ?? remote.record?.origin ?? "",
  };
};

/**
 * The pairing screen for a pair that already exists, with the servers and the way messages
 * travel fixed: only the address each side reaches the other at can change. Each side keeps the
 * credential it holds, and its server proves the new address answers as the same peer before it
 * records it, so nothing waiting is cancelled.
 */
export function PeerEditDialog({
  pair,
  onClose,
}: {
  readonly pair: PeerPair;
  readonly onClose: () => void;
}) {
  const sides = editableSides(pair);
  const other = (side: PeerPairSide) =>
    pair.sides[0].environmentId === side.environmentId ? pair.sides[1] : pair.sides[0];
  const firstBaseUrl = useEnvironmentHttpBaseUrl(pair.sides[0].environmentId);
  const secondBaseUrl = useEnvironmentHttpBaseUrl(pair.sides[1].environmentId);
  const baseUrls = new Map([
    [pair.sides[0].environmentId, firstBaseUrl],
    [pair.sides[1].environmentId, secondBaseUrl],
  ]);
  const [reaches, setReaches] = useState<ReadonlyMap<string, PeeringReach> | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReadonlyArray<StepReport> | null>(null);

  // Keyed on the pair and the addresses this client uses; the side objects are rebuilt on every read.
  const checkKey = sides
    .map(
      (side) =>
        `${side.environmentId}>${other(side).environmentId}@${side.record.origin}|${baseUrls.get(other(side).environmentId) ?? ""}`,
    )
    .join(",");
  /* oxlint-disable react/exhaustive-effect-dependencies -- Keyed on checkKey; see above. */
  // oxlint-disable-next-line t3code/react-effect-budget -- checks each side's reach from the server whenever the pair changes, and drops a stale answer.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      sides.map(async (side) => {
        const to = other(side);
        const reach = await runReachCheck(
          side.environmentId,
          {
            server: { environmentId: to.environmentId, label: to.label },
            clientUrl: baseUrls.get(to.environmentId) ?? null,
          },
          side.record.origin,
        );
        return [side.environmentId, reach] as const;
      }),
    ).then((results) => {
      if (!cancelled) setReaches(new Map(results));
    });
    return () => {
      cancelled = true;
    };
  }, [checkKey]);
  /* oxlint-enable react/exhaustive-effect-dependencies */

  // Each field holds the address the check proved until the person types their own.
  const valueOf = (side: EditableSide) => {
    const edited = edits.get(side.environmentId);
    if (edited !== undefined) return edited;
    const reach = reaches?.get(side.environmentId);
    return reach?.kind === "reached" ? reach.origin : side.record.origin;
  };
  const changed = sides.filter((side) => cleanOrigin(valueOf(side)) !== side.record.origin);
  const ready =
    !busy &&
    changed.length > 0 &&
    changed.every((side) => isPeerOrigin(cleanOrigin(valueOf(side))));
  const origins = new Map(sides.map((side) => [side.environmentId, valueOf(side)] as const));
  const allReached =
    reaches !== null && sides.every((side) => reaches.get(side.environmentId)?.kind === "reached");

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setReport(null);
    const steps: Array<StepReport> = [];
    // Each side is its own server's change, so one that is refused never keeps the other from being tried.
    for (const side of changed) {
      const title = `Change the address ${side.label} reaches ${other(side).label} at`;
      try {
        await changePeerOrigin(
          side.environmentId,
          other(side).environmentId,
          cleanOrigin(valueOf(side)),
        );
        steps.push({ title, status: "done", detail: null });
      } catch (cause) {
        steps.push({
          title,
          status: "failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    for (const side of pair.sides) refreshPeers(side.environmentId as EnvironmentId);
    setBusy(false);
    if (steps.every((step) => step.status === "done")) onClose();
    else setReport(steps);
  };

  return (
    <Dialog
      open
      // Closing waits like Cancel does: a change in flight reports into this dialog.
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit peering</DialogTitle>
          <DialogDescription>
            Change the address each server reaches the other at. Each server keeps its credential,
            so messages waiting and open Exchanges carry on. To change how messages travel, remove
            the peer and peer again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FixedServer title="Server" label={pair.sides[0].label} />
              <FixedServer title="Peer with" label={pair.sides[1].label} />
            </div>

            {reaches === null ? (
              <Alert>
                <AlertTitle>
                  Checking how {pair.sides[0].label} and {pair.sides[1].label} reach each other…
                </AlertTitle>
              </Alert>
            ) : (
              <Alert variant={allReached ? "success" : "warning"}>
                <AlertDescription>
                  <ul className="space-y-1.5">
                    {sides.map((side) => {
                      const reach = reaches.get(side.environmentId);
                      return reach === undefined ? null : (
                        <ReachLine
                          key={side.environmentId}
                          from={side}
                          to={other(side)}
                          reach={reach}
                        />
                      );
                    })}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <Alert variant="info">
              <AlertTitle>How messages travel</AlertTitle>
              <AlertDescription>
                <ul className="space-y-1 text-foreground">
                  {peeringLines(choiceOf(pair, origins), pair.sides[0], pair.sides[1]).map(
                    (line) => (
                      <li key={line}>{line}</li>
                    ),
                  )}
                </ul>
              </AlertDescription>
            </Alert>

            <div className={sides.length > 1 ? "grid gap-4 sm:grid-cols-2" : undefined}>
              {sides.map((side) => {
                const value = valueOf(side);
                return (
                  <div key={side.environmentId} className="flex flex-col gap-1.5">
                    <OriginField
                      title={`${side.label} reaches ${other(side).label} at`}
                      value={value}
                      onChange={(next) =>
                        setEdits((current) => new Map(current).set(side.environmentId, next))
                      }
                      disabled={busy}
                    />
                    {cleanOrigin(value) !== side.record.origin ? (
                      <span className="text-xs text-muted-foreground">
                        Was {side.record.origin}.
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>

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
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The pairing screen's server picker, fixed: a pair's servers never change. */
function FixedServer({ title, label }: { readonly title: string; readonly label: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
      {title}
      <Select disabled value={label}>
        <SelectTrigger className="w-full" aria-label={title}>
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          <SelectItem value={label}>{label}</SelectItem>
        </SelectPopup>
      </Select>
    </label>
  );
}
