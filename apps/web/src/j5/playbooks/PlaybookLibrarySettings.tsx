import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  playbookStepLabel,
  playbookWorkspaces,
  samePlaybookWorkspaceInputs,
} from "@t3tools/client-runtime/j5/playbooks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import { isProjectInSettingsScope } from "../settingsScopeEnvironment.logic";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentFolderPickerDialog } from "../agents/AgentFolderPickerDialog";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import { j5Environment } from "../state";
import { playbookImportName } from "./importPlaybookFile";
import { openPlaybookDraft } from "./openPlaybookDraft";

const workspaceInputsAtom = Atom.make((get) => ({
  projects: get(environmentProjects.projectsAtom),
  threads: get(environmentThreadShells.threadShellsAtom).filter(
    (thread) => thread.deletedAt === null && thread.worktreePath !== null,
  ),
}));
const playbookWorkspaceInputsAtom = Atom.withEquality(
  workspaceInputsAtom,
  samePlaybookWorkspaceInputs,
).pipe(Atom.withLabel("j5-playbook-workspace-inputs"));

export function PlaybookLibrarySettings() {
  const { environments } = useEnvironments();
  const workspaceInputs = useAtomValue(playbookWorkspaceInputsAtom);
  const guestEnvironmentIds = useGuestEnvironmentIds();
  // The settings scope sentence narrows the workspaces and, when it names no
  // environment, the representative environment's workspace comes first.
  const settings = useOptionalSettingsScope();
  const settingsScope = settings?.scope;
  const representativeEnvironmentId = settings?.environment?.environmentId;
  const workspaces = useMemo(
    () =>
      playbookWorkspaces(workspaceInputs.projects, workspaceInputs.threads).filter(
        (entry) =>
          // A guest is not offered a server's Playbooks (Shared server AC24).
          !guestEnvironmentIds.has(entry.environmentId) &&
          (settingsScope === undefined ||
            isProjectInSettingsScope(settingsScope, entry.environmentId, entry.projectId)),
      ),
    [guestEnvironmentIds, settingsScope, workspaceInputs],
  );
  const [workspaceKey, setWorkspaceKey] = useState("");
  const workspace =
    workspaces.find((entry) => entry.key === workspaceKey) ??
    workspaces.find((entry) => entry.environmentId === representativeEnvironmentId) ??
    workspaces[0];
  const workspaceItems = workspaces.map((entry) => ({
    value: entry.key,
    label:
      entry.title +
      (environments.length > 1
        ? ` · ${environments.find((env) => env.environmentId === entry.environmentId)?.label ?? entry.environmentId}`
        : ""),
  }));
  const query = useEnvironmentQuery(
    workspace
      ? j5Environment.playbookLibrary({
          environmentId: workspace.environmentId,
          input: {
            projectId: workspace.projectId,
            ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          },
        })
      : null,
  );
  const { refresh } = query;
  // Creating, importing, renaming and deleting a playbook change the workspace.
  const canOperate = useAtomValue(
    j5Environment.deletePlaybook.permissionAtom(workspace?.environmentId ?? null),
  );
  const libraryPath = workspace
    ? `${query.data?.workspaceRoot ?? workspace.workspaceRoot}/.j5/playbooks`
    : null;
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const openThread = useNewThreadHandler();
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const readCatalog = useAtomQueryRunner(agentPersonaEnvironment.catalog, {
    reportFailure: false,
    refresh: true,
  });
  const createPersona = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const authorStarting = useRef(false);
  const authorLaunch = useRef<{
    workspaceKey: string;
    target: Parameters<typeof startTurn>[0];
  } | null>(null);
  const [picking, setPicking] = useState(false);
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const deletePlaybook = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const exportPlaybook = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const renamePlaybook = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const [renameTarget, setRenameTarget] = useState<{ name: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function createPlaybook() {
    if (!workspace || !query.data || busy || authorStarting.current) return;
    authorStarting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { environmentId } = workspace;
      const workspaceKey = JSON.stringify([workspace.key, query.data.workspaceRoot]);
      // Retain the command on failure: retrying a lost reply must reopen the same thread.
      if (authorLaunch.current?.workspaceKey !== workspaceKey) {
        const modelSelection = await ensurePlaybookAuthor({
          providers: serverConfigs.get(environmentId)?.providers ?? [],
          readCatalog: async () => {
            const result = await readCatalog({ environmentId, input: {} });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          createPersona: async (input) => {
            const result = await createPersona({ environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        });
        const createdAt = new Date().toISOString();
        authorLaunch.current = {
          workspaceKey,
          target: playbookAuthorLaunch({
            workspace: { ...workspace, workspaceRoot: query.data.workspaceRoot },
            modelSelection,
            commandId: CommandId.make(randomUUID()),
            threadId: newThreadId(),
            messageId: newMessageId(),
            createdAt,
          }),
        };
      }
      const { target } = authorLaunch.current;
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
        throw new Error(
          "The authoring thread was created but has not synced yet. Choose Create playbook again to reopen it.",
        );
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      authorLaunch.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Playbook Author.");
    } finally {
      authorStarting.current = false;
      setBusy(false);
    }
  }
  /** Copies a YAML file from the environment's machine into the workspace's playbook library. */
  async function importFile(path: string) {
    if (!workspace || !query.data || busy) return;
    setBusy(true);
    setError(null);
    const { environmentId } = workspace;
    const cwd = query.data.workspaceRoot;
    try {
      // An absolute path reads the host file wherever it lives.
      const read = await readFile({ environmentId, input: { cwd, relativePath: path } });
      if (read._tag === "Failure") throw squashAtomCommandFailure(read);
      const name = playbookImportName(path, read.value.byteLength);
      if (
        query.data.playbooks.some((playbook) => playbook.name === name) &&
        !window.confirm(`Replace ${name}.yaml?`)
      )
        return;
      const result = await writeFile({
        environmentId,
        input: {
          cwd,
          relativePath: `.j5/playbooks/${name}.yaml`,
          contents: read.value.contents,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import playbook YAML files.");
    } finally {
      refresh();
      setBusy(false);
    }
  }
  async function removePlaybook(name: string) {
    if (!workspace || !query.data || query.error || busy) return;
    if (!window.confirm(`Delete ${name}.yaml from ${workspace.title}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deletePlaybook({
        environmentId: workspace.environmentId,
        input: {
          projectId: workspace.projectId,
          ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          name,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete playbook.");
    } finally {
      setBusy(false);
    }
  }
  async function downloadPlaybook(name: string) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await exportPlaybook({
        environmentId: workspace.environmentId,
        input: {
          projectId: workspace.projectId,
          ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          name,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const { fileName, yaml } = result.value;
      const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      // Revoking synchronously can abort the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toastManager.add({ type: "success", title: `Exported ${fileName}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export playbook.");
    } finally {
      setBusy(false);
    }
  }
  async function submitRename() {
    if (!workspace || !renameTarget || busy) return;
    const title = renameTarget.title.trim();
    if (!title) return;
    if (title === query.data?.playbooks.find(({ name }) => name === renameTarget.name)?.title) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await renamePlaybook({
        environmentId: workspace.environmentId,
        input: {
          projectId: workspace.projectId,
          ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          name: renameTarget.name,
          title,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setRenameTarget(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename playbook.");
    } finally {
      setBusy(false);
    }
  }
  async function openDraft(prompt: string) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      if ((await openPlaybookDraft(workspace, prompt, openThread)) === "preserved")
        toastManager.add({
          type: "info",
          title: "Draft preserved",
          description:
            "Your existing text or attachments are still here. Finish or clear this draft, then choose the playbook action again.",
        });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open a conversation.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {picking && workspace ? (
        <AgentFolderPickerDialog
          environmentId={workspace.environmentId}
          environmentLabel={
            environments.find((env) => env.environmentId === workspace.environmentId)?.label ??
            "this environment"
          }
          mode="file"
          title="Import a playbook file"
          confirmLabel="Import"
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setPicking(false);
            void importFile(path);
          }}
        />
      ) : null}
      <SettingsSection
        title="Playbooks"
        id="playbooks"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!workspace || busy || !canOperate || !query.data || !!query.error}
              onClick={() => void createPlaybook()}
            >
              <PlusIcon aria-hidden="true" className="size-3" />
              Create playbook
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!workspace || busy || !canOperate || !query.data || !!query.error}
              onClick={() => setPicking(true)}
            >
              Import YAML
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Refresh playbooks"
                    disabled={!workspace || busy || query.isPending}
                    onClick={refresh}
                  >
                    <RefreshCwIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>Refresh playbooks</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <SettingsRow
          title="Workspace"
          description={
            libraryPath && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className="block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  {libraryPath}
                </TooltipTrigger>
                <TooltipPopup className="max-w-sm break-all">{libraryPath}</TooltipPopup>
              </Tooltip>
            )
          }
          control={
            <Select
              items={workspaceItems}
              value={workspace?.key ?? null}
              disabled={busy || !workspace}
              onValueChange={(value) => {
                if (value === null) return;
                setRenameTarget(null);
                setWorkspaceKey(value);
                setError(null);
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Playbook workspace">
                <SelectValue placeholder="No projects available" />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {workspaceItems.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {(error || query.error) && !renameTarget && (
          <SettingsRow
            title={query.error ? "Playbooks unavailable" : "Playbook action failed"}
            status={
              <p role="alert" className="text-destructive">
                {error ?? query.error}
              </p>
            }
          />
        )}
        {!workspace && (
          <SettingsRow
            title="No workspace available"
            description="Connect an environment and add a project to create playbooks."
          />
        )}
        {query.isPending && !query.data && <SettingsRow title="Loading playbooks…" role="status" />}
        {query.data?.playbooks.length === 0 && (
          <SettingsRow
            title="No playbooks in this workspace yet"
            description="Playbooks guide an agent through ordered steps. Import a YAML file or create one with your agent."
          />
        )}
        {query.data?.playbooks.map((playbook) => (
          <SettingsRow
            key={playbook.name}
            title={playbook.title}
            description={playbook.description}
            status={
              <div className="space-y-1">
                <span className="block">{playbook.name}.yaml</span>
                {playbook.issue ? (
                  <p role="status" className="text-destructive">
                    {playbook.issue.message}
                  </p>
                ) : (
                  <>
                    <ol
                      className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                      aria-label={`${playbook.title} steps`}
                    >
                      {playbook.steps.map((step, index) => (
                        <li key={step.id} className="min-w-0 break-words">
                          {playbookStepLabel(step, index)}
                        </li>
                      ))}
                    </ol>
                    {(playbook.warnings ?? []).map((warning) => (
                      <p
                        key={`${warning.stepId}:${warning.code}`}
                        role="status"
                        className="text-xs text-warning"
                      >
                        {warning.message}
                      </p>
                    ))}
                  </>
                )}
              </div>
            }
            control={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !!query.error || !!playbook.issue}
                  onClick={() => void openDraft(`Start playbook ${playbook.name}`)}
                >
                  Prepare chat
                </Button>
                <Menu>
                  <MenuTrigger
                    disabled={busy || !!query.error}
                    aria-label={`More actions for ${playbook.title}`}
                    render={<Button variant="ghost" size="icon-sm" />}
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      disabled={busy || !!query.error || !!playbook.issue}
                      onClick={() => void downloadPlaybook(playbook.name)}
                    >
                      <DownloadIcon />
                      Export YAML
                    </MenuItem>
                    <MenuItem
                      disabled={busy || !canOperate || !!query.error || !!playbook.issue}
                      onClick={() => {
                        setError(null);
                        setRenameTarget({ name: playbook.name, title: playbook.title });
                      }}
                    >
                      <PencilIcon />
                      Rename
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      variant="destructive"
                      disabled={busy || !canOperate || !!query.error}
                      onClick={() => void removePlaybook(playbook.name)}
                    >
                      <Trash2Icon />
                      Delete
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </>
            }
          >
            {renameTarget?.name === playbook.name ? (
              <div className="space-y-3 py-2">
                <form
                  className="flex max-w-xl flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRename();
                  }}
                >
                  <Input
                    nativeInput
                    autoFocus
                    size="sm"
                    className="min-w-0 flex-1 basis-40"
                    aria-label={`Name for ${playbook.name} playbook`}
                    value={renameTarget.title}
                    disabled={busy}
                    onChange={(event) =>
                      setRenameTarget({ ...renameTarget, title: event.currentTarget.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenameTarget(null);
                    }}
                  />
                  <Button size="sm" type="submit" disabled={busy || !renameTarget.title.trim()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setRenameTarget(null)}
                  >
                    Cancel
                  </Button>
                </form>
                {error || query.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error ?? query.error}
                  </p>
                ) : null}
              </div>
            ) : null}
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  );
}
