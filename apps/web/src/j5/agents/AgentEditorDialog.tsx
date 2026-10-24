import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaEditInput, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

export function AgentEditorDialog(props: {
  environmentId: EnvironmentId;
  initial: Omit<AgentPersonaEditInput, "instructions">;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  // Instructions are not in the catalog; load them once the dialog opens.
  const [instructions, setInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  useEffect(() => {
    let cancelled = false;
    void read({ environmentId: props.environmentId, input: { personaId: props.initial.personaId } })
      .then((result) => {
        if (cancelled) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setInstructions(result.value.definition.instructions);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.initial.personaId, read]);
  async function submit() {
    if (saving || instructions === null) return;
    setSaving(true);
    setError(null);
    const result = await save({
      environmentId: props.environmentId,
      input: {
        ...draft,
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        instructions,
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
    } else {
      props.onSaved();
    }
    setSaving(false);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl" showCloseButton={!saving}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit persona</DialogTitle>
            <DialogDescription>
              Changes apply to this imported copy and future launches. The original file and
              existing tasks stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="grid gap-1.5 text-sm">
              Name
              <Input
                value={draft.displayName}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Description
              <Textarea
                value={draft.description}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Instructions
              <div className="font-mono">
                <Textarea
                  value={instructions ?? ""}
                  required
                  disabled={saving || instructions === null}
                  placeholder={instructions === null ? "Loading…" : undefined}
                  className="min-h-40"
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                Markdown. Instructions describe behavior; the runtime policy below is what is
                enforced.
              </span>
            </label>
            <AgentRoutePolicyFields
              environmentId={props.environmentId}
              value={draft}
              retainRoute={props.initial.modelRoute}
              disabled={saving}
              onChange={(next) => setDraft({ ...draft, ...next })}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                saving ||
                instructions === null ||
                !instructions.trim() ||
                !draft.displayName.trim() ||
                !draft.description.trim()
              }
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
