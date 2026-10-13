import { useAtomValue } from "@effect/atom-react";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { AgentImportConflictSelection } from "./AgentImportConflictSelection";
import { AgentCreateDialog } from "./AgentCreateDialog";
import {
  agentPersonaDuplicateDraft,
  type AgentPersonaCreateDraft,
} from "@t3tools/client-runtime/j5/agent-personas";
import { AgentEditorDialog } from "./AgentEditorDialog";
import { AgentFolderPickerDialog } from "./AgentFolderPickerDialog";
import {
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  agentPersonaFolderNudges,
  agentPersonaFolderStatusLabel,
  agentPersonaUsageById,
  importAgentPersonasWithConfirmation,
  presentAgentPersonaCatalog,
  presentAgentPersonaUsage,
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaEditInput,
  AgentPersonaImportConflict,
  AgentPersonaImportConflictError,
  EnvironmentId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSettingsScopeEnvironments } from "../settingsScopeEnvironment";
import {
  GUEST_LIBRARY_UNAVAILABLE,
  useGuestEnvironmentIds,
  useIsGuestEverywhere,
} from "../sharing/guestAccess";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { PlaybookLibrarySettings } from "../playbooks/PlaybookLibrarySettings";
import { useEnvironmentQuery } from "../../state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "../../components/settings/settingsLayout";

export function AgentLibrarySettings() {
  // A guest is not offered a server's Personas or Playbooks (Shared server AC24).
  return useIsGuestEverywhere() ? (
    <SettingsPageContainer>
      <SettingsSection title="Personas">
        <SettingsUnavailableGroup message={GUEST_LIBRARY_UNAVAILABLE}>
          {null}
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  ) : (
    <MemberAgentLibrarySettings />
  );
}

function MemberAgentLibrarySettings() {
  const { environments: connected, isReady } = useEnvironments();
  const guestEnvironmentIds = useGuestEnvironmentIds();
  const environments = useMemo(
    () => connected.filter((environment) => !guestEnvironmentIds.has(environment.environmentId)),
    [connected, guestEnvironmentIds],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedEnvironments = useMemo(
    () =>
      environments.toSorted((left, right) => {
        const leftPrimary = left.environmentId === primaryEnvironmentId;
        const rightPrimary = right.environmentId === primaryEnvironmentId;
        return Number(rightPrimary) - Number(leftPrimary) || left.label.localeCompare(right.label);
      }),
    [environments, primaryEnvironmentId],
  );
  const {
    candidates: pickerEnvironments,
    pinnedEnvironmentId,
    initialEnvironmentId,
  } = useSettingsScopeEnvironments(orderedEnvironments, primaryEnvironmentId);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    initialEnvironmentId,
  );
  const effectiveEnvironmentId =
    pinnedEnvironmentId ??
    (pickerEnvironments.some((environment) => environment.environmentId === selectedEnvironmentId)
      ? selectedEnvironmentId
      : (pickerEnvironments[0]?.environmentId ?? null));
  const selectedEnvironment = orderedEnvironments.find(
    (environment) => environment.environmentId === effectiveEnvironmentId,
  );
  const catalog = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.catalog({
          environmentId: effectiveEnvironmentId,
          input: {},
        }),
  );
  const usage = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.usage({ environmentId: effectiveEnvironmentId, input: {} }),
  );
  const usageById = useMemo(() => agentPersonaUsageById(usage.data), [usage.data]);
  const librarySources = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.librarySources({
          environmentId: effectiveEnvironmentId,
          input: {},
        }),
  );
  const availableEditors =
    useServerConfigs().get(effectiveEnvironmentId ?? ("" as EnvironmentId))?.availableEditors ?? [];
  const openInEditor = useOpenInPreferredEditor(effectiveEnvironmentId, availableEditors);
  const setLibraryFolders = useAtomCommand(agentPersonaEnvironment.setLibraryFolders, {
    reportFailure: false,
  });
  /** Which question the environment path picker is answering, if it is open. */
  const [picking, setPicking] = useState<"library-folder" | "import-file" | "import-folder" | null>(
    null,
  );
  const otherEnvironments = orderedEnvironments.filter(
    (environment) => environment.environmentId !== effectiveEnvironmentId,
  );
  const [busy, setBusy] = useState(false);
  // A session that may not change the library can still read and export it.
  const canOperate = useAtomValue(
    agentPersonaEnvironment.createAgentPersona.permissionAtom(effectiveEnvironmentId),
  );
  const locked = busy || !canOperate;
  const [creating, setCreating] = useState<{ initial?: AgentPersonaCreateDraft } | null>(null);
  const [editing, setEditing] = useState<{
    environmentId: EnvironmentId;
    initial: Omit<AgentPersonaEditInput, "instructions">;
  } | null>(null);
  const importAgents = useAtomCommand(agentPersonaEnvironment.importAgentPersonas, {
    reportFailure: false,
  });
  const readImportFiles = useAtomCommand(agentPersonaEnvironment.readImportFiles, {
    reportFailure: false,
  });
  const removeAgent = useAtomCommand(agentPersonaEnvironment.removeAgentPersona, {
    reportFailure: false,
  });
  const restoreAgent = useAtomCommand(agentPersonaEnvironment.restoreSourceAgentPersona, {
    reportFailure: false,
  });
  const readAgent = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  async function confirmReplacement(
    error: AgentPersonaImportConflictError,
  ): Promise<ReadonlyArray<AgentPersonaImportConflict> | null> {
    let selected = error.conflicts;
    const confirmation = requestConfirmDialog(
      "Replace existing personas?",
      { variant: "destructive" },
      {
        confirmLabel: "Import selected",
        content: (
          <AgentImportConflictSelection
            key={JSON.stringify(error.conflicts)}
            error={error}
            onChange={(value) => {
              selected = value;
            }}
          />
        ),
      },
    );
    if (confirmation === undefined)
      throw new Error(
        "The confirmation dialog is unavailable. Please reopen Settings and try again.",
      );
    return (await confirmation) ? selected : null;
  }
  /** Export plus import in one gesture: the target environment validates and resolves ID conflicts. */
  async function copyPersona(
    personaId: string,
    target: { environmentId: EnvironmentId; label: string },
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const { definition, fileName, yaml } = await readDefinition(personaId);
      const result = await importAgentPersonasWithConfirmation(
        [{ name: fileName, content: yaml }],
        async (input) => {
          const response = await importAgents({ environmentId: target.environmentId, input });
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          return response.value;
        },
        confirmReplacement,
      );
      if (result === null) return;
      toastManager.add({
        type: "success",
        title:
          result.importedIds.length === 0
            ? `${target.label} kept its existing ${definition.displayName}`
            : `Copied ${definition.displayName} to ${target.label}`,
      });
      if (target.environmentId === effectiveEnvironmentId) catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function saveFolders(folders: ReadonlyArray<string>) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await setLibraryFolders({ environmentId, input: { folders } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      librarySources.refresh();
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Library folders not saved",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function openFolder(path: string) {
    const result = await openInEditor(path);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not open folder",
        description: "Sign in to an editor on this environment, or open the path shown above.",
      });
  }
  /** Imports a YAML file, or every YAML file under a folder, from the environment's machine. */
  async function importFromPath(path: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const read = await readImportFiles({ environmentId, input: { path } });
      if (read._tag === "Failure") throw squashAtomCommandFailure(read);
      const result = await importAgentPersonasWithConfirmation(
        read.value.files,
        async (input) => {
          const response = await importAgents({ environmentId, input });
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          return response.value;
        },
        confirmReplacement,
      );
      if (result === null) return;
      toastManager.add({
        type: "success",
        title: `Imported ${result.importedIds.length} persona(s).`,
      });
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  const setAgentEnabled = useAtomCommand(agentPersonaEnvironment.setAgentPersonaEnabled, {
    reportFailure: false,
  });
  async function toggleAgent(personaId: string, enabled: boolean) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await setAgentEnabled({ environmentId, input: { personaId, enabled } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function removePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await removeAgent({
        environmentId,
        input: { personaId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({ type: "success", title: "Persona removed" });
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function readDefinition(personaId: string) {
    if (effectiveEnvironmentId === null) throw new Error("Select an environment first.");
    const result = await readAgent({
      environmentId: effectiveEnvironmentId,
      input: { personaId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  }
  async function duplicatePersona(personaId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { definition } = await readDefinition(personaId);
      setCreating({ initial: agentPersonaDuplicateDraft(definition) });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function exportPersona(personaId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { fileName, yaml } = await readDefinition(personaId);
      const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      toastManager.add({ type: "success", title: `Exported ${fileName}` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function restorePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await restoreAgent({ environmentId, input: { personaId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({ type: "success", title: "Persona restored" });
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  const personas =
    catalog.data === null || catalog.data === undefined
      ? []
      : presentAgentPersonaCatalog(catalog.data);

  return (
    <SettingsPageContainer>
      {pinnedEnvironmentId === null && pickerEnvironments.length > 1 ? (
        <SettingsSection title="Environment">
          <SettingsRow
            title="Environment"
            description="Availability and model routing are resolved by the selected environment."
            control={
              <Select
                disabled={busy}
                value={effectiveEnvironmentId ?? undefined}
                onValueChange={(value) => {
                  const environment = pickerEnvironments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  if (environment) setSelectedEnvironmentId(environment.environmentId);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label="Persona environment"
                >
                  <SelectValue>{selectedEnvironment?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {pickerEnvironments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Personas"
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={locked || effectiveEnvironmentId === null}
              onClick={() => setCreating({})}
            >
              <PlusIcon aria-hidden="true" className="size-3" />
              Create persona
            </Button>
            <Menu>
              <MenuTrigger
                render={<Button size="xs" variant="ghost-muted" />}
                disabled={locked || effectiveEnvironmentId === null}
              >
                Import
                <ChevronDownIcon aria-hidden="true" className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  disabled={locked || effectiveEnvironmentId === null}
                  onClick={() => setPicking("import-file")}
                >
                  Persona file
                </MenuItem>
                <MenuItem
                  disabled={locked || effectiveEnvironmentId === null}
                  onClick={() => setPicking("import-folder")}
                >
                  Folder
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        }
      >
        {effectiveEnvironmentId === null ? (
          <SettingsRow
            title={isReady ? "No connected environments" : "Loading environments"}
            description="Connect an environment to inspect its persona library."
          />
        ) : catalog.isPending ? (
          <SettingsRow title="Loading personas" description="Reading the persona library." />
        ) : catalog.error ? (
          <SettingsRow title="Personas unavailable" description={catalog.error} />
        ) : personas.length === 0 ? (
          <SettingsRow
            title="No personas"
            description="This environment’s library is empty. In a Codex or Claude conversation, type @persona:id, or @ and a persona’s name, to run one as a subagent."
          />
        ) : (
          personas.map((persona) => {
            const usageEntry = usageById.get(persona.personaId);
            const usageSummary =
              usageEntry === undefined ? null : presentAgentPersonaUsage(usageEntry);
            return (
              <SettingsRow
                key={persona.personaId}
                title={persona.displayName}
                description={persona.description}
                status={
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {persona.blockedReasons.length > 0 ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={<Badge variant="warning">{persona.availabilityLabel}</Badge>}
                        />
                        <TooltipPopup className="max-w-sm">
                          {persona.blockedReasons.map((reason) => (
                            <span key={reason} className="block">
                              {reason}
                            </span>
                          ))}
                        </TooltipPopup>
                      </Tooltip>
                    ) : (
                      <Badge variant={persona.availability === "available" ? "success" : "outline"}>
                        {persona.availabilityLabel}
                      </Badge>
                    )}
                    {persona.unsandboxed ? <Badge variant="warning">Full access</Badge> : null}
                    {persona.originLabel ? (
                      <>
                        <span aria-hidden="true">·</span>
                        {persona.origin?.kind === "folder" ? (
                          <Tooltip>
                            <TooltipTrigger render={<span>{persona.originLabel}</span>} />
                            <TooltipPopup variant="code">{persona.origin.path}</TooltipPopup>
                          </Tooltip>
                        ) : (
                          <span>{persona.originLabel}</span>
                        )}
                      </>
                    ) : null}
                    {usageSummary ? (
                      usageSummary.routes.length === 0 ? (
                        <span className="basis-full">{usageSummary.line}</span>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger
                            render={<span className="basis-full">{usageSummary.line}</span>}
                          />
                          <TooltipPopup>
                            {usageSummary.routes.map((route) => (
                              <span key={route} className="block">
                                {route}
                              </span>
                            ))}
                          </TooltipPopup>
                        </Tooltip>
                      )
                    ) : null}
                    {persona.availability === "unsupported" ? (
                      <span className="basis-full">{persona.blockedReasons[0]}</span>
                    ) : persona.edit === null && !persona.removed ? (
                      <span className="basis-full">Duplicate this persona to edit a copy</span>
                    ) : null}
                  </div>
                }
                control={
                  <>
                    {persona.removed ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={locked}
                        aria-label={`Restore ${persona.displayName}`}
                        onClick={() => void restorePersona(persona.personaId)}
                      >
                        <Undo2Icon className="size-4" />
                        Restore
                      </Button>
                    ) : (
                      <Switch
                        checked={persona.enabled}
                        disabled={locked}
                        aria-label={`Enable ${persona.displayName}`}
                        onCheckedChange={(enabled) => void toggleAgent(persona.personaId, enabled)}
                      />
                    )}
                    <Menu>
                      <MenuTrigger
                        disabled={busy}
                        aria-label={`More actions for ${persona.displayName}`}
                        render={<Button variant="ghost" size="icon-sm" />}
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {persona.removed ? null : (
                          <MenuItem
                            disabled={locked || persona.edit === null}
                            onClick={() => {
                              if (persona.edit && effectiveEnvironmentId)
                                setEditing({
                                  environmentId: effectiveEnvironmentId,
                                  initial: persona.edit,
                                });
                            }}
                          >
                            <PencilIcon />
                            Edit
                          </MenuItem>
                        )}
                        <MenuItem
                          disabled={!canOperate || persona.availability === "unsupported"}
                          onClick={() => void duplicatePersona(persona.personaId)}
                        >
                          <CopyIcon />
                          Duplicate as personal persona
                        </MenuItem>
                        <MenuItem onClick={() => void exportPersona(persona.personaId)}>
                          <DownloadIcon />
                          Export YAML
                        </MenuItem>
                        {otherEnvironments.length > 0 ? (
                          <MenuSub>
                            <MenuSubTrigger>Copy to environment</MenuSubTrigger>
                            <MenuSubPopup>
                              {otherEnvironments.map((environment) => (
                                <MenuItem
                                  key={environment.environmentId}
                                  onClick={() =>
                                    void copyPersona(persona.personaId, {
                                      environmentId: environment.environmentId,
                                      label: environment.label,
                                    })
                                  }
                                >
                                  {environment.label}
                                </MenuItem>
                              ))}
                            </MenuSubPopup>
                          </MenuSub>
                        ) : null}
                        {persona.removed ? null : (
                          <>
                            <MenuSeparator />
                            <MenuItem
                              variant="destructive"
                              disabled={locked}
                              onClick={() => void removePersona(persona.personaId)}
                            >
                              <Trash2Icon />
                              Remove
                            </MenuItem>
                          </>
                        )}
                      </MenuPopup>
                    </Menu>
                  </>
                }
              />
            );
          })
        )}
      </SettingsSection>

      {effectiveEnvironmentId !== null ? (
        <SettingsSection
          title="Library sources"
          headerAction={
            librarySources.data && !librarySources.isPending && !librarySources.error ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={locked}
                onClick={() => setPicking("library-folder")}
              >
                <PlusIcon aria-hidden="true" className="size-3" />
                Add folder
              </Button>
            ) : null
          }
        >
          {librarySources.isPending ? (
            <SettingsRow title="Loading folders" description="Reading the library configuration." />
          ) : librarySources.error ? (
            <SettingsRow title="Folders unavailable" description={librarySources.error} />
          ) : librarySources.data ? (
            <>
              {librarySources.data.folders.length === 0 ? (
                <SettingsRow
                  title="No source folders"
                  description="Only personal and imported personas are available."
                />
              ) : null}
              {librarySources.data.folders.map((folder) => {
                const nudges = agentPersonaFolderNudges(folder.git);
                const configured = librarySources.data?.configured;
                const canOpen = folder.exists && availableEditors.length > 0;
                return (
                  <SettingsRow
                    key={folder.configuredPath}
                    title={<span className="font-mono text-sm">{folder.configuredPath}</span>}
                    description={
                      folder.path !== folder.configuredPath || !configured ? (
                        <>
                          {folder.path !== folder.configuredPath ? (
                            <span className="block font-mono text-xs">{folder.path}</span>
                          ) : null}
                          {configured ? null : (
                            <span className="block">
                              Adding a folder replaces the bundled examples.
                            </span>
                          )}
                        </>
                      ) : null
                    }
                    status={
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge variant={folder.exists || !configured ? "outline" : "error"}>
                          {agentPersonaFolderStatusLabel(folder, configured)}
                        </Badge>
                        {nudges.map((nudge) => (
                          <span key={nudge} className="text-warning-foreground">
                            {nudge}
                          </span>
                        ))}
                      </div>
                    }
                    control={
                      <Menu>
                        <MenuTrigger
                          disabled={busy}
                          aria-label={`Actions for ${folder.configuredPath}`}
                          render={<Button variant="ghost" size="icon-sm" />}
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          {canOpen ? (
                            <>
                              <MenuItem
                                disabled={locked}
                                onClick={() => void openFolder(folder.path)}
                              >
                                <ExternalLinkIcon />
                                Open in editor
                              </MenuItem>
                              <MenuSeparator />
                            </>
                          ) : null}
                          <MenuItem
                            variant="destructive"
                            disabled={locked}
                            onClick={() =>
                              void saveFolders(
                                (librarySources.data?.folders ?? [])
                                  .map(({ configuredPath }) => configuredPath)
                                  .filter((candidate) => candidate !== folder.configuredPath),
                              )
                            }
                          >
                            <Trash2Icon />
                            Stop reading folder
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    }
                  />
                );
              })}
            </>
          ) : null}
        </SettingsSection>
      ) : null}
      {picking && effectiveEnvironmentId ? (
        <AgentFolderPickerDialog
          key={picking}
          environmentId={effectiveEnvironmentId}
          environmentLabel={selectedEnvironment?.label ?? "this environment"}
          mode={picking === "import-file" ? "file" : "folder"}
          title={
            picking === "library-folder"
              ? "Choose a library folder"
              : picking === "import-file"
                ? "Import a persona file"
                : "Import a persona folder"
          }
          confirmLabel={picking === "library-folder" ? "Choose folder" : "Import"}
          onClose={() => setPicking(null)}
          onSelect={(path) => {
            setPicking(null);
            if (picking !== "library-folder") return void importFromPath(path);
            void saveFolders([
              ...(librarySources.data?.folders ?? []).map(({ configuredPath }) => configuredPath),
              path,
            ]);
          }}
        />
      ) : null}
      {creating && effectiveEnvironmentId ? (
        <AgentCreateDialog
          environmentId={effectiveEnvironmentId}
          {...(creating.initial ? { initial: creating.initial } : {})}
          onClose={() => setCreating(null)}
          onCreated={(displayName) => {
            setCreating(null);
            toastManager.add({ type: "success", title: `Created ${displayName}` });
            catalog.refresh();
          }}
        />
      ) : null}
      {editing ? (
        <AgentEditorDialog
          key={`${editing.environmentId}:${editing.initial.personaId}`}
          {...editing}
          onClose={() => {
            setEditing(null);
            catalog.refresh();
          }}
          onSaved={() => {
            setEditing(null);
            catalog.refresh();
          }}
        />
      ) : null}
      <PlaybookLibrarySettings />
    </SettingsPageContainer>
  );
}
