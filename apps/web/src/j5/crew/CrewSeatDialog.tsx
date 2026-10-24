import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CrewProposalSeat,
  CrewProposalSeatRuntime,
  CrewWorkspaceOptions,
} from "@t3tools/contracts/j5";
import { useState } from "react";

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
import { useCrewProposalPreview } from "./useCrewProposalPreview";
import { CUSTOM_AGENT } from "./crewProposalDraft";
import { CrewSeatEditor } from "./CrewSeatEditor";
import { crewSeatDraft, resolvedCrewSeatDraft, type CrewSeatDraft } from "./crewSeatRuntime";

/** Local drafts are published only by Save/Add; closing the dialog leaves approval unchanged. */
export function CrewSeatDialog(props: {
  readonly seat: CrewProposalSeat | null;
  readonly proposalId: string;
  readonly previewSeatName: string;
  readonly runtime?: CrewProposalSeatRuntime | undefined;
  /** What the Captain's repository offers a seat's workspace, from the roster's preview. */
  readonly workspaceOptions?: CrewWorkspaceOptions | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly agents: ReadonlyArray<{ readonly personaId: string; readonly displayName: string }>;
  readonly disabled: boolean;
  readonly onSave: (draft: CrewSeatDraft) => string | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<CrewSeatDraft>(() => {
    if (props.seat === null)
      return {
        seat: "",
        agentId: CUSTOM_AGENT,
        instructions: "",
        // A seat the person adds starts in the Captain's checkout.
        workspace: { type: "shared" },
      };
    const initial = crewSeatDraft(props.seat);
    return props.seat.agentId === null ? resolvedCrewSeatDraft(initial, props.runtime) : initial;
  });
  const [error, setError] = useState<string | null>(null);
  const originalRuntime =
    props.seat !== null && draft.agentId === (props.seat.agentId ?? CUSTOM_AGENT)
      ? props.runtime
      : undefined;
  // Resolve persona defaults before editing a new selection. This does not save the draft or
  // authorize approval; the full roster gets a fresh preview when the user saves the member.
  const previewSeats = [
    {
      seat: props.previewSeatName,
      agentId: draft.agentId === CUSTOM_AGENT ? null : draft.agentId,
      reason: "Member runtime preview",
      workspace: { type: "shared" as const },
      ...(draft.agentId === CUSTOM_AGENT ? { instructions: "Crew member" } : {}),
    },
  ];
  const preview = useCrewProposalPreview(
    props.environmentId,
    props.proposalId,
    previewSeats,
    props.disabled || originalRuntime !== undefined,
  );
  const matchingRuntime = originalRuntime ?? preview.data?.seats[0];
  const adding = props.seat === null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.disabled) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl" showCloseButton={!props.disabled}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.disabled) return;
            const nextError = props.onSave(draft);
            setError(nextError);
            if (nextError === null) props.onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{adding ? "Add crew member" : `Edit ${props.seat!.seat}`}</DialogTitle>
            <DialogDescription>
              {adding
                ? "Choose a saved persona or configure a custom crew member."
                : "Update this member’s instructions and runtime settings."}{" "}
              Runtime settings are checked before you approve the crew.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {/* The Captain's reason is why this seat exists. It is read here, never edited: the
                roster keeps the original reason when the member is saved (see saveSeat). */}
            {props.seat?.reason ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Reason</span>{" "}
                <span className="break-words">{props.seat.reason}</span>
              </p>
            ) : null}
            <CrewSeatEditor
              value={draft}
              environmentId={props.environmentId}
              agents={props.agents}
              runtime={matchingRuntime}
              workspaceOptions={props.workspaceOptions ?? preview.data?.workspaceOptions}
              disabled={props.disabled}
              existing={!adding}
              onChange={setDraft}
            />
            {originalRuntime === undefined && preview.error ? (
              <div className="flex items-center gap-2">
                <p role="alert" className="text-sm text-destructive">
                  {preview.error}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.disabled}
                  onClick={preview.refresh}
                >
                  Retry runtime
                </Button>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={props.disabled}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={props.disabled}>
              {adding ? "Add member" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
