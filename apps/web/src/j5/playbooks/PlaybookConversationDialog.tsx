import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  playbookWorkspaces,
} from "@t3tools/client-runtime/j5/playbooks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";
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
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentProviders } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { buildThreadRouteParams } from "../../threadRoutes";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import { openPlaybookDraft } from "./openPlaybookDraft";

/** A project locates the conversation, never the playbook's storage or visibility. */
export function PlaybookConversationDialog({
  environmentId,
  name,
  projectId = null,
  onClose,
}: {
  environmentId: EnvironmentId;
  name: string | null;
  /** The project Settings is showing, so a project playbook's chat opens where it lives. */
  projectId?: ProjectId | null;
  onClose: () => void;
}) {
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const workspaces = playbookWorkspaces(
    projects.filter((project) => project.environmentId === environmentId),
    [],
  );
  const [selected, setSelected] = useState(
    (workspaces.find((entry) => entry.projectId === projectId) ?? workspaces[0])?.key ?? "",
  );
  const workspace = workspaces.find((entry) => entry.key === selected) ?? workspaces[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const openThread = useNewThreadHandler();
  const providersByEnvironment = useEnvironmentProviders();
  const readCatalog = useAtomQueryRunner(agentPersonaEnvironment.catalog, {
    reportFailure: false,
    refresh: true,
  });
  const readAuthor = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  const editAuthor = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const createPersona = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const launch = useRef<{ key: string; target: Parameters<typeof startTurn>[0] } | null>(null);
  async function submit() {
    if (!workspace || busy) return;
    // The compiler cannot lower a throw inside try, so the steps throw from their own function.
    const openConversation = async () => {
      if (name !== null) {
        if (
          (await openPlaybookDraft(workspace, `Start playbook ${name}`, openThread)) === "preserved"
        ) {
          toastManager.add({
            type: "info",
            title: "Draft preserved",
            description: "Finish or clear your existing draft, then choose the playbook again.",
          });
        }
      } else {
        if (launch.current?.key !== workspace.key) {
          const modelSelection = await ensurePlaybookAuthor({
            providers: providersByEnvironment.get(environmentId) ?? [],
            readCatalog: async () => {
              const result = await readCatalog({ environmentId, input: {} });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return result.value;
            },
            readDefinition: async (personaId) => {
              const result = await readAuthor({ environmentId, input: { personaId } });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return result.value.definition;
            },
            editPersona: async (input) => {
              const result = await editAuthor({ environmentId, input });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
            createPersona: async (input) => {
              const result = await createPersona({ environmentId, input });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
          });
          launch.current = {
            key: workspace.key,
            target: playbookAuthorLaunch({
              workspace,
              modelSelection,
              commandId: CommandId.make(randomUUID()),
              threadId: newThreadId(),
              messageId: newMessageId(),
              createdAt: new Date().toISOString(),
            }),
          };
        }
        const { target } = launch.current;
        const result = await startTurn(target);
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const threadRef = scopeThreadRef(environmentId, target.input.threadId);
        const visible = await waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentThreadShells.threadShellAtom(threadRef),
          predicate: (thread) => thread !== null,
          timeoutMs: 5_000,
        });
        if (!visible)
          throw new Error("The authoring thread hasn't synced yet. Try again to reopen it.");
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }
    };
    setBusy(true);
    setError(null);
    try {
      await openConversation();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the conversation.");
    }
    setBusy(false);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{name === null ? "Create playbook" : "Prepare chat"}</DialogTitle>
          <DialogDescription>
            {name === null
              ? "Choose a project for the conversation. New playbooks are saved to the environment library."
              : "Choose the project to run the playbook in."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {workspace ? (
            <Select
              items={workspaces.map((entry) => ({ value: entry.key, label: entry.title }))}
              value={workspace.key}
              disabled={busy}
              onValueChange={(value) => {
                if (value) setSelected(value);
              }}
            >
              <SelectTrigger aria-label="Conversation project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {workspaces.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <p className="text-sm text-muted-foreground">
              Add a project to open a conversation. You can import playbooks without one.
            </p>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !workspace} onClick={() => void submit()}>
            {name === null ? "Open Playbook Author" : "Prepare chat"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
