import {
  GUEST_LIBRARY_UNAVAILABLE,
  useGuestEnvironmentIds,
  useIsGuestEverywhere,
} from "../sharing/guestAccess";
import { AgentLibraryToast, type AgentLibraryNotification } from "./AgentLibraryToast";
import { AgentImportConflictModal } from "./AgentImportConflictModal";
import { AgentCreateModal } from "./AgentCreateModal";
import {
  agentPersonaDuplicateDraft,
  type AgentPersonaCreateDraft,
} from "@t3tools/client-runtime/j5/agent-personas";
import { AgentEditorModal } from "./AgentEditorModal";
import { AgentFolderPickerModal } from "./AgentFolderPickerModal";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import {
  agentPersonaFolderNudges,
  agentPersonaFolderStatusLabel,
  agentPersonaUsageById,
  presentAgentPersonaCatalog,
  presentAgentPersonaUsage,
  importAgentPersonasWithConfirmation,
} from "@t3tools/client-runtime/j5/agent-personas";
import {
  type AgentPersonaEditInput,
  type AgentPersonaImportConflict,
  type AgentPersonaImportConflictError,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Platform, Pressable, ScrollView, Share, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { pickAgentDefinitions } from "./pickAgentDefinitions";
import { useAtomCommand } from "../../state/use-atom-command";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { PlaybookLibrarySettingsSection } from "../playbooks/PlaybookLibrarySettingsScreen";

export function AgentLibrarySettingsScreen() {
  // A guest is not offered a server's Personas or Playbooks (Shared server AC24).
  return useIsGuestEverywhere() ? (
    <View className="p-4">
      <AgentMessage title={GUEST_LIBRARY_UNAVAILABLE} />
    </View>
  ) : (
    <MemberAgentLibrarySettingsScreen />
  );
}

function MemberAgentLibrarySettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments: connected } = useRemoteConnectionStatus();
  const guestEnvironmentIds = useGuestEnvironmentIds();
  const connectedEnvironments = useMemo(
    () => connected.filter((environment) => !guestEnvironmentIds.has(environment.environmentId)),
    [connected, guestEnvironmentIds],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const effectiveEnvironmentId = connectedEnvironments.some(
    (environment) => environment.environmentId === selectedEnvironmentId,
  )
    ? selectedEnvironmentId
    : (connectedEnvironments[0]?.environmentId ?? null);
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
  const setLibraryFolders = useAtomCommand(agentPersonaEnvironment.setLibraryFolders, {
    reportFailure: false,
  });
  const [pickingFolder, setPickingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  // A session that may not change the library can still read and export it.
  const canOperate = useAtomValue(
    agentPersonaEnvironment.createAgentPersona.permissionAtom(effectiveEnvironmentId),
  );
  const locked = busy || !canOperate;
  // Copying a persona imports it into the target, so only targets that permit the import are offered.
  const otherEnvironments = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          connectedEnvironments.filter(
            (environment) =>
              environment.environmentId !== effectiveEnvironmentId &&
              get(
                agentPersonaEnvironment.importAgentPersonas.permissionAtom(
                  environment.environmentId,
                ),
              ),
          ),
        ),
      [connectedEnvironments, effectiveEnvironmentId],
    ),
  );
  const [confirmation, setConfirmation] = useState<{
    error: AgentPersonaImportConflictError;
    resolve: (selected: ReadonlyArray<AgentPersonaImportConflict> | null) => void;
  } | null>(null);
  useEffect(() => () => confirmation?.resolve(null), [confirmation]);
  const [editing, setEditing] = useState<{
    environmentId: EnvironmentId;
    initial: Omit<AgentPersonaEditInput, "instructions">;
  } | null>(null);
  const [notification, setNotification] = useState<AgentLibraryNotification | null>(null);
  const [creating, setCreating] = useState<{ initial?: AgentPersonaCreateDraft } | null>(null);
  const dismissNotification = useCallback(() => setNotification(null), []);
  const importAgents = useAtomCommand(agentPersonaEnvironment.importAgentPersonas, {
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
  const confirmReplacement = (error: AgentPersonaImportConflictError) =>
    new Promise<ReadonlyArray<AgentPersonaImportConflict> | null>((resolve) => {
      setConfirmation({ error, resolve });
    });
  /** Export plus import in one gesture; the target environment validates and resolves ID conflicts. */
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
      setNotification({
        type: "success",
        title:
          result.importedIds.length === 0
            ? `${target.label} kept its existing ${definition.displayName}`
            : `Copied ${definition.displayName} to ${target.label}`,
      });
    } catch (error) {
      setNotification({
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
      setNotification({
        type: "error",
        title: "Library folders not saved",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function importSelection(kind: "folder" | "agent") {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const files = await pickAgentDefinitions(kind);
      if (files === null) return;
      const result = await importAgentPersonasWithConfirmation(
        files,
        async (input) => {
          const response = await importAgents({ environmentId, input });
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          return response.value;
        },
        confirmReplacement,
      );
      if (result === null) return;
      setNotification({
        type: "success",
        title: `Imported ${result.importedIds.length} persona(s).`,
      });
      catalog.refresh();
    } catch (error) {
      setNotification({
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
      setNotification({
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
      setNotification({ type: "success", title: "Persona removed" });
      catalog.refresh();
    } catch (error) {
      setNotification({
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
      setNotification({
        type: "error",
        title: "Persona action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  /** Native platforms share a real .yaml file; the web build falls back to sharing the text. */
  async function exportPersona(personaId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { fileName, yaml } = await readDefinition(personaId);
      if (Platform.OS === "web") {
        await Share.share({ title: fileName, message: yaml });
      } else {
        const [FileSystem, Sharing] = await Promise.all([
          import("expo-file-system/legacy"),
          import("expo-sharing"),
        ]);
        const uri = `${FileSystem.cacheDirectory ?? ""}${fileName}`;
        await FileSystem.writeAsStringAsync(uri, yaml);
        await Sharing.shareAsync(uri, { mimeType: "application/yaml", dialogTitle: fileName });
      }
    } catch (error) {
      setNotification({
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
      setNotification({ type: "success", title: "Persona restored" });
      catalog.refresh();
    } catch (error) {
      setNotification({
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
    <View collapsable={false} className="flex-1 bg-sheet">
      {confirmation ? (
        <AgentImportConflictModal
          key={JSON.stringify(confirmation.error.conflicts)}
          error={confirmation.error}
          onConfirm={(selected) => {
            confirmation.resolve(selected);
            setConfirmation(null);
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Personas" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Persona library">
          <View className="rounded-2xl bg-card px-4 py-3">
            <Text className="text-base text-foreground">
              In a Codex or Claude conversation, type @persona:id, or @ and the start of a persona’s
              name, to run a persona as a subagent. Edit imported personas here.
            </Text>
          </View>
        </SettingsSection>

        {connectedEnvironments.length > 1 ? (
          <SettingsSection title="Environment">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {connectedEnvironments.map((environment) => {
                  const selected = environment.environmentId === effectiveEnvironmentId;
                  return (
                    <Pressable
                      key={environment.environmentId}
                      accessibilityLabel={environment.environmentLabel}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      className={cn(
                        "rounded-full border px-4 py-2",
                        selected ? "border-primary bg-primary/10" : "border-border bg-card",
                      )}
                      disabled={busy}
                      onPress={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Text className="text-sm font-t3-medium text-foreground">
                        {environment.environmentLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </SettingsSection>
        ) : null}

        <View className="flex-row flex-wrap items-center justify-between gap-3 px-2">
          <Text className="text-sm font-t3-medium text-foreground-muted">Scoped personas</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create persona"
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              className="flex-row items-center gap-2 rounded-lg border border-border px-4 py-3 disabled:opacity-40"
              onPress={() => setCreating({})}
            >
              <SymbolView
                name="plus"
                size={14}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-sm text-foreground">Create</Text>
            </Pressable>
            {Platform.OS === "web" ? (
              <Text className="text-sm text-foreground-muted">
                Use Settings → Personas in the web app to import files.
              </Text>
            ) : (
              <View className="self-start" pointerEvents={locked ? "none" : "auto"}>
                <ControlPillMenu
                  actions={[
                    {
                      id: "agent",
                      title: "Persona file",
                      attributes: { disabled: locked },
                    },
                    {
                      id: "folder",
                      title: "Folder",
                      attributes: { disabled: locked },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "agent" || nativeEvent.event === "folder")
                      void importSelection(nativeEvent.event);
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Import personas"
                    accessibilityState={{ disabled: locked }}
                    disabled={locked}
                    className="flex-row items-center gap-2 rounded-lg border border-border px-4 py-3 disabled:opacity-40"
                  >
                    <Text className="text-sm text-foreground">Import</Text>
                    <SymbolView
                      name="chevron.down"
                      size={14}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  </Pressable>
                </ControlPillMenu>
              </View>
            )}
          </View>
        </View>
        <SettingsSection>
          <View className="gap-2">
            {effectiveEnvironmentId === null ? (
              <AgentMessage title="No connected environments" />
            ) : catalog.isPending ? (
              <AgentMessage title="Loading personas" />
            ) : catalog.error ? (
              <AgentMessage title={catalog.error} />
            ) : personas.length === 0 ? (
              <AgentMessage title="No personas in this library" />
            ) : (
              personas.map((persona) => {
                const available = persona.availability === "available";
                return (
                  <View key={persona.personaId} className="gap-2 rounded-2xl bg-card px-4 py-3">
                    <View className="flex-row items-center gap-3">
                      <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
                        <Text className="shrink text-lg font-t3-semibold text-foreground">
                          {persona.displayName}
                        </Text>
                        <View
                          className={cn(
                            "rounded-full border px-2 py-0.5",
                            available ? "border-primary/30 bg-primary/10" : "border-border",
                          )}
                        >
                          <Text className="text-xs font-t3-medium text-foreground-muted">
                            {persona.availabilityLabel}
                          </Text>
                        </View>
                        {persona.unsandboxed ? (
                          <View className="rounded-full border border-warning-border bg-warning px-2 py-0.5">
                            <Text className="text-xs font-t3-medium text-warning-foreground">
                              Full access
                            </Text>
                          </View>
                        ) : null}
                        {persona.originLabel ? (
                          <View className="rounded-full border border-border px-2 py-0.5">
                            <Text className="text-xs font-t3-medium text-foreground-muted">
                              {persona.originLabel}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <View className="flex-row items-center gap-2">
                        {persona.removed ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Restore ${persona.displayName}`}
                            accessibilityState={{ disabled: locked }}
                            disabled={locked}
                            className="h-11 flex-row items-center gap-2 rounded-lg border border-border px-3 disabled:opacity-40"
                            onPress={() => void restorePersona(persona.personaId)}
                          >
                            <SymbolView
                              name="arrow.uturn.backward"
                              size={16}
                              tintColorClassName="accent-icon"
                              type="monochrome"
                            />
                            <Text className="text-sm text-foreground">Restore</Text>
                          </Pressable>
                        ) : (
                          <>
                            <Switch
                              value={persona.enabled}
                              disabled={locked}
                              accessibilityLabel={`Enable ${persona.displayName}`}
                              onValueChange={(enabled) =>
                                void toggleAgent(persona.personaId, enabled)
                              }
                            />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Edit ${persona.displayName}`}
                              accessibilityHint={
                                persona.edit
                                  ? "Edit this imported copy"
                                  : "Duplicate this persona to edit a copy"
                              }
                              accessibilityState={{ disabled: locked || persona.edit === null }}
                              disabled={locked || persona.edit === null}
                              className="size-11 items-center justify-center rounded-lg disabled:opacity-40"
                              onPress={() => {
                                if (persona.edit && effectiveEnvironmentId)
                                  setEditing({
                                    environmentId: effectiveEnvironmentId,
                                    initial: persona.edit,
                                  });
                              }}
                            >
                              <SymbolView
                                name="pencil"
                                size={18}
                                tintColorClassName="accent-icon"
                                type="monochrome"
                              />
                            </Pressable>
                          </>
                        )}
                        <ControlPillMenu
                          actions={[
                            {
                              id: "duplicate",
                              title: "Duplicate as personal persona",
                              attributes: {
                                disabled: locked || persona.availability === "unsupported",
                              },
                            },
                            { id: "export", title: "Export YAML", attributes: { disabled: busy } },
                            ...(otherEnvironments.length === 0
                              ? []
                              : [
                                  {
                                    id: "copy",
                                    title: "Copy to environment",
                                    attributes: { disabled: busy },
                                    subactions: otherEnvironments.map((environment) => ({
                                      id: `copy:${environment.environmentId}`,
                                      title: environment.environmentLabel,
                                    })),
                                  },
                                ]),
                          ]}
                          onPressAction={({ nativeEvent }) => {
                            if (nativeEvent.event === "duplicate")
                              void duplicatePersona(persona.personaId);
                            else if (nativeEvent.event === "export")
                              void exportPersona(persona.personaId);
                            else if (nativeEvent.event.startsWith("copy:")) {
                              const target = otherEnvironments.find(
                                (environment) =>
                                  `copy:${environment.environmentId}` === nativeEvent.event,
                              );
                              if (target)
                                void copyPersona(persona.personaId, {
                                  environmentId: target.environmentId,
                                  label: target.environmentLabel,
                                });
                            }
                          }}
                        >
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`More actions for ${persona.displayName}`}
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            className="size-11 items-center justify-center rounded-lg disabled:opacity-40"
                          >
                            <SymbolView
                              name="ellipsis"
                              size={18}
                              tintColorClassName="accent-icon"
                              type="monochrome"
                            />
                          </Pressable>
                        </ControlPillMenu>
                        {persona.removed ? null : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${persona.displayName}`}
                            accessibilityState={{ disabled: locked }}
                            disabled={locked}
                            className="size-11 items-center justify-center rounded-lg border border-danger-foreground/30 disabled:opacity-40"
                            onPress={() => void removePersona(persona.personaId)}
                          >
                            <SymbolView
                              name="trash"
                              size={18}
                              tintColorClassName="accent-danger-foreground"
                              type="monochrome"
                            />
                          </Pressable>
                        )}
                      </View>
                    </View>
                    <Text className="text-sm text-foreground-muted">{persona.description}</Text>
                    {persona.blockedReasons.map((reason) => (
                      <Text key={reason} className="text-xs text-foreground-muted">
                        {reason}
                      </Text>
                    ))}
                    {(() => {
                      const entry = usageById.get(persona.personaId);
                      if (entry === undefined) return null;
                      const summary = presentAgentPersonaUsage(entry);
                      return (
                        <Text
                          className="text-xs text-foreground-muted"
                          accessibilityHint={summary.routes.join(". ")}
                        >
                          {summary.line}
                        </Text>
                      );
                    })()}
                  </View>
                );
              })
            )}
          </View>
        </SettingsSection>

        {effectiveEnvironmentId !== null ? (
          <SettingsSection title="Library sources">
            <View className="gap-2">
              <View className="rounded-2xl bg-card px-4 py-3">
                <Text className="text-sm text-foreground-muted">
                  Folders this environment reads YAML definitions from. Paths are on the
                  environment’s machine; relative paths resolve from its state directory.
                </Text>
              </View>
              {librarySources.isPending ? (
                <AgentMessage title="Loading folders" />
              ) : librarySources.error ? (
                <AgentMessage title={librarySources.error} />
              ) : librarySources.data ? (
                <>
                  {librarySources.data.folders.length === 0 ? (
                    <AgentMessage title="No source folders. Only personal and imported personas are available." />
                  ) : null}
                  {librarySources.data.folders.map((folder) => {
                    const nudges = agentPersonaFolderNudges(folder.git);
                    return (
                      <View
                        key={folder.configuredPath}
                        className="gap-2 rounded-2xl bg-card px-4 py-3"
                      >
                        <View className="flex-row items-center gap-3">
                          <View className="min-w-0 flex-1 gap-1">
                            <Text className="text-base font-t3-medium text-foreground">
                              {folder.configuredPath}
                            </Text>
                            {folder.path !== folder.configuredPath ? (
                              <Text className="text-xs text-foreground-muted">{folder.path}</Text>
                            ) : null}
                          </View>
                          <View
                            className={cn(
                              "rounded-full border px-2 py-0.5",
                              folder.exists || !librarySources.data?.configured
                                ? "border-border"
                                : "border-danger-foreground/30",
                            )}
                          >
                            <Text
                              className={cn(
                                "text-xs font-t3-medium",
                                folder.exists || !librarySources.data?.configured
                                  ? "text-foreground-muted"
                                  : "text-danger-foreground",
                              )}
                            >
                              {agentPersonaFolderStatusLabel(
                                folder,
                                librarySources.data?.configured,
                              )}
                            </Text>
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Stop reading ${folder.configuredPath}`}
                            accessibilityState={{ disabled: locked }}
                            disabled={locked}
                            className="size-11 items-center justify-center rounded-lg border border-danger-foreground/30 disabled:opacity-40"
                            onPress={() =>
                              void saveFolders(
                                (librarySources.data?.folders ?? [])
                                  .map(({ configuredPath }) => configuredPath)
                                  .filter((candidate) => candidate !== folder.configuredPath),
                              )
                            }
                          >
                            <SymbolView
                              name="trash"
                              size={18}
                              tintColorClassName="accent-danger-foreground"
                              type="monochrome"
                            />
                          </Pressable>
                        </View>
                        {nudges.map((nudge) => (
                          <Text key={nudge} className="text-sm text-foreground">
                            {nudge}
                          </Text>
                        ))}
                      </View>
                    );
                  })}
                  <View className="gap-2 rounded-2xl bg-card px-4 py-3">
                    <Text className="text-sm text-foreground-muted">
                      {librarySources.data.configured
                        ? "Files are read on every catalog request, so edits and git pulls apply without a restart."
                        : "Bundled examples appear until a folder is configured or the default folder exists. Adding a folder writes agent-personas.json."}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Add folder"
                      accessibilityState={{ disabled: locked }}
                      disabled={locked}
                      className="flex-row items-center gap-2 self-start rounded-lg border border-border px-4 py-3 disabled:opacity-40"
                      onPress={() => setPickingFolder(true)}
                    >
                      <SymbolView
                        name="folder"
                        size={14}
                        tintColorClassName="accent-icon"
                        type="monochrome"
                      />
                      <Text className="text-sm text-foreground">Add folder</Text>
                    </Pressable>
                  </View>
                </>
              ) : null}
            </View>
          </SettingsSection>
        ) : null}
        <SettingsSection title="Playbooks">
          <PlaybookLibrarySettingsSection />
        </SettingsSection>
      </ScrollView>
      {notification ? (
        <AgentLibraryToast notification={notification} onDismiss={dismissNotification} />
      ) : null}
      {pickingFolder && effectiveEnvironmentId ? (
        <AgentFolderPickerModal
          environmentId={effectiveEnvironmentId}
          environmentLabel={
            connectedEnvironments.find(
              (environment) => environment.environmentId === effectiveEnvironmentId,
            )?.environmentLabel ?? "this environment"
          }
          onClose={() => setPickingFolder(false)}
          onSelect={(path) => {
            setPickingFolder(false);
            void saveFolders([
              ...(librarySources.data?.folders ?? []).map(({ configuredPath }) => configuredPath),
              path,
            ]);
          }}
        />
      ) : null}
      {creating && effectiveEnvironmentId ? (
        <AgentCreateModal
          environmentId={effectiveEnvironmentId}
          {...(creating.initial ? { initial: creating.initial } : {})}
          onClose={() => setCreating(null)}
          onCreated={(displayName) => {
            setCreating(null);
            setNotification({ type: "success", title: `Created ${displayName}` });
            catalog.refresh();
          }}
        />
      ) : null}
      {editing ? (
        <AgentEditorModal
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
    </View>
  );
}

function AgentMessage(props: { readonly title: string }) {
  return (
    <View className="rounded-2xl bg-card px-4 py-4">
      <Text className="text-base text-foreground-muted">{props.title}</Text>
    </View>
  );
}
