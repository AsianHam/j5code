import { useAtomValue } from "@effect/atom-react";
import {
  agentPersonaIdError,
  agentPersonaIdFromName,
  agentPersonaPolicyDrivers,
  defaultAgentPersonaModelRoute,
  type AgentPersonaCreateDraft,
} from "@t3tools/client-runtime/j5/agent-personas";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaModelTarget,
  EnvironmentId,
} from "@t3tools/contracts";
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
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

const INSTRUCTIONS_PLACEHOLDER = `# Who this persona is

Describe its identity, what it looks for, and how it works.`;

/** Author a personal persona; it is stored as an imported definition of this environment. */
export function AgentCreateDialog(props: {
  environmentId: EnvironmentId;
  /** Prefill from an existing agent (Duplicate); the ID is treated as user-chosen. */
  initial?: AgentPersonaCreateDraft;
  onClose: () => void;
  onCreated: (displayName: string) => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  // New personas start on read-only, so prefer a provider that sandboxes it.
  const defaultRoute = defaultAgentPersonaModelRoute(
    providers ?? [],
    agentPersonaPolicyDrivers(catalog.data, "read-only"),
  );
  const [draft, setDraft] = useState<{
    displayName: string;
    id: string;
    idEdited: boolean;
    description: string;
    instructions: string;
    authorityPolicy: AgentPersonaAuthorityPolicy;
    modelRoute: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget] | null;
  }>(
    props.initial
      ? { ...props.initial, idEdited: true }
      : {
          displayName: "",
          id: "",
          idEdited: false,
          description: "",
          instructions: "",
          authorityPolicy: "read-only",
          modelRoute: null,
        },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelRoute = draft.modelRoute ?? defaultRoute;
  const idError = agentPersonaIdError(draft.id);
  const create = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  const ready =
    !saving &&
    idError === null &&
    draft.displayName.trim() !== "" &&
    draft.description.trim() !== "" &&
    draft.instructions.trim() !== "" &&
    modelRoute !== null;
  async function submit() {
    if (!ready || modelRoute === null) return;
    setSaving(true);
    setError(null);
    const result = await create({
      environmentId: props.environmentId,
      input: {
        id: draft.id,
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions,
        authorityPolicy: draft.authorityPolicy,
        modelRoute: [modelRoute[0], modelRoute[1]],
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
    } else {
      props.onCreated(draft.displayName.trim());
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
            <DialogTitle>{props.initial ? "Duplicate persona" : "Create persona"}</DialogTitle>
            <DialogDescription>
              A personal persona for this environment. It joins the library like an import, so you
              can edit, switch off, or remove it later.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="grid gap-1.5 text-sm">
              Name
              <Input
                value={draft.displayName}
                required
                disabled={saving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    displayName: event.target.value,
                    id: draft.idEdited ? draft.id : agentPersonaIdFromName(event.target.value),
                  })
                }
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              ID
              <Input
                value={draft.id}
                required
                disabled={saving}
                aria-invalid={draft.id !== "" && idError !== null}
                onChange={(event) =>
                  setDraft({ ...draft, id: event.target.value.trim(), idEdited: true })
                }
              />
              <span className="text-xs text-muted-foreground">
                {draft.id !== "" && idError !== null
                  ? idError
                  : "Stable identifier used in @persona: mentions. Lowercase letters, digits, hyphens."}
              </span>
            </label>
            <label className="grid gap-1.5 text-sm">
              Description
              <Textarea
                value={draft.description}
                required
                disabled={saving}
                placeholder="One sentence on what this persona is for."
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Instructions
              <div className="font-mono">
                <Textarea
                  value={draft.instructions}
                  required
                  disabled={saving}
                  className="min-h-40"
                  placeholder={INSTRUCTIONS_PLACEHOLDER}
                  onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                Markdown. Instructions describe behavior; the runtime policy below is what is
                enforced.
              </span>
            </label>
            {modelRoute === null ? (
              <p className="text-sm text-muted-foreground">
                Sign in to Codex or Claude on this environment to choose the agent's models.
              </p>
            ) : (
              <AgentRoutePolicyFields
                environmentId={props.environmentId}
                value={{ authorityPolicy: draft.authorityPolicy, modelRoute }}
                disabled={saving}
                onChange={(next) => setDraft({ ...draft, ...next })}
              />
            )}
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
            <Button type="submit" disabled={!ready}>
              {saving ? "Creating…" : "Create persona"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
