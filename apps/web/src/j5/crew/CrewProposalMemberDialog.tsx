import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewMemberModels, CrewWorkspaceOptions } from "@t3tools/contracts/j5";
import { useEffect, useEffectEvent, useState, type RefObject } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogPanel,
  DialogPopup,
} from "../../components/ui/dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import {
  CUSTOM_AGENT,
  crewMemberInstructions,
  crewProposalRoster,
  type CrewProposalRow,
} from "./crewProposalDraft";
import { CrewSeatEditor } from "./CrewSeatEditor";
import { chooseCrewSeatPersona, type CrewSeatDraft } from "./crewSeatRuntime";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

export function CrewProposalMemberDialog(props: {
  row: CrewProposalRow;
  returnFocus: RefObject<HTMLButtonElement | null>;
  rows: ReadonlyArray<CrewProposalRow>;
  proposalId: string;
  previewSeatName: string;
  environmentId: EnvironmentId | null;
  workspaceOptions?: CrewWorkspaceOptions | undefined;
  memberModels?: CrewMemberModels | undefined;
  agents: ReadonlyArray<{ personaId: string; displayName: string }>;
  disabled: boolean;
  onClose: () => void;
  onSave: (value: CrewSeatDraft) => void;
}) {
  const [value, setValue] = useState(props.row.value);
  const [personaInstructions, setPersonaInstructions] = useState<string | null>(null);
  const [seed, setSeed] = useState<Parameters<typeof crewMemberInstructions>[2]>(null);
  const [loadedPersona, setLoadedPersona] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, { reportFailure: false });
  const personaId = value.agentId;
  const custom = personaId === CUSTOM_AGENT;
  const loadingPersona = !custom && loadedPersona !== personaId;
  const currentDraft = useEffectEvent(() => value);

  // oxlint-disable-next-line t3code/react-effect-budget -- reads the chosen persona from the server whenever the choice changes, and drops a stale answer.
  useEffect(() => {
    if (custom || props.environmentId === null || personaError !== null) return;
    let current = true;
    const { instructions: extra, personaInstructions: edited } = currentDraft();
    void read({ environmentId: props.environmentId, input: { personaId } }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setPersonaError(cause instanceof Error ? cause.message : "Could not load persona.");
          return;
        }
        const instructions = result.value.definition.instructions;
        const text = edited ?? (extra ? `${instructions}\n\n${extra}` : instructions);
        setPersonaInstructions(instructions);
        setSeed({ text, instructions: extra, personaInstructions: edited });
        setValue((draft) => ({ ...draft, instructions: text }));
        setLoadedPersona(personaId);
        setPersonaError(null);
      },
      (cause: unknown) => {
        if (current)
          setPersonaError(cause instanceof Error ? cause.message : "Could not load persona.");
      },
    );
    return () => {
      current = false;
    };
  }, [custom, personaId, props.environmentId, read, personaError]);

  const { personaInstructions: _edited, ...rest } = value;
  const saved: CrewSeatDraft = {
    ...rest,
    ...crewMemberInstructions(value.instructions, personaInstructions, seed),
  };
  const roster = crewProposalRoster([
    ...props.rows.filter((row) => row.id !== props.row.id),
    { ...props.row, value: saved },
  ]);
  const error = roster.errors.get(props.row.id);
  // Runtime defaults can be repaired independently of invalid names, instructions, or workspaces.
  // Only the card's complete roster preview can authorize approval.
  const seats = [
    {
      seat: props.previewSeatName,
      agentId: custom ? null : personaId,
      reason: "Member runtime preview",
      workspace: { type: "shared" as const },
      ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
      ...(value.runtimeMode ? { runtimeMode: value.runtimeMode } : {}),
      ...(custom ? { instructions: "Crew member" } : {}),
    },
  ];
  const preview = useCrewProposalPreview(
    props.environmentId,
    props.proposalId,
    seats,
    props.disabled,
  );
  const runtime = preview.runtimeSeats?.[0];
  const blocked = props.disabled || loadingPersona || personaError !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup finalFocus={props.returnFocus} className="sm:max-w-xl" showCloseButton={false}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div>
            <DialogPrimitive.Title className="text-base font-medium">
              {props.row.original === null ? "Add member" : "Edit member"}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
              {props.row.original === null
                ? "Define a new member for the proposed Crew."
                : "Update this member in the proposed Crew."}
            </DialogPrimitive.Description>
          </div>
          <DialogClose aria-label="Close" render={<Button size="icon-xs" variant="ghost" />}>
            <XIcon />
          </DialogClose>
        </div>
        <DialogPanel>
          <CrewSeatEditor
            value={value}
            environmentId={props.environmentId}
            agents={props.agents}
            runtime={runtime}
            workspaceOptions={props.workspaceOptions ?? preview.workspaceOptions}
            memberModels={props.memberModels}
            disabled={props.disabled}
            loadingInstructions={loadingPersona}
            onChange={setValue}
            onMenuOpenChange={() => undefined}
            onPersonaChange={(agentId) => {
              setPersonaInstructions(null);
              setSeed(null);
              setLoadedPersona(null);
              setPersonaError(null);
              const agent = props.agents.find((agent) => agent.personaId === agentId);
              setValue((draft) => ({
                ...chooseCrewSeatPersona(draft, agentId),
                ...(agent ? { seat: agent.displayName, instructions: "" } : {}),
              }));
            }}
          />
          {personaInstructions !== null &&
          value.instructions.trim() !== personaInstructions.trim() ? (
            <Button
              className="mt-2"
              size="xs"
              type="button"
              variant="link"
              disabled={props.disabled}
              onClick={() => setValue((draft) => ({ ...draft, instructions: personaInstructions }))}
            >
              Reset to persona text
            </Button>
          ) : null}
          {loadingPersona && !personaError ? (
            <p className="mt-3 text-xs text-muted-foreground" role="status">
              Loading persona instructions…
            </p>
          ) : null}
          {personaError ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-destructive" role="alert">
                {personaError}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPersonaError(null);
                }}
              >
                Retry persona
              </Button>
            </div>
          ) : null}
          {error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {preview.error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {preview.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <p className="mr-auto text-xs text-muted-foreground">
            Changes apply to the proposal. Nobody starts yet.
          </p>
          <Button size="lg" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-foreground bg-foreground px-3 text-xs font-medium text-background hover:bg-foreground/90 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
            disabled={blocked || error !== undefined || runtime === undefined}
            onClick={() => props.onSave(saved)}
          >
            {props.row.original === null ? "Add member" : "Save changes"}
          </button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
