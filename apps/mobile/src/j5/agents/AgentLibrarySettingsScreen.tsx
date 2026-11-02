import { LIBRARY_FOR_OWNERS } from "@t3tools/client-runtime/j5/sharing";
import { useOwnedEnvironmentIds, useOwnerSomewhere } from "../sharing/guestAccess";
import { AgentLibraryToast, type AgentLibraryNotification } from "./AgentLibraryToast";
import { AgentImportConflictModal } from "./AgentImportConflictModal";
import { agentPersonaDuplicateDraft } from "@t3tools/client-runtime/j5/agent-personas";
import { AgentDetailsModal } from "./AgentDetailsModal";
import { AgentFolderPickerModal } from "./AgentFolderPickerModal";
import { usePersonaFormNavigation } from "./PersonaFormScreen";
import { sendWhenReconnected } from "./watchEnvironmentSessions";
import { personaRowActions } from "./personaRowActions";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  agentPersonaFolderNudges,
  agentPersonaFolderStatusLabel,
  agentPersonaUsageById,
  presentAgentPersonaCatalog,
  presentAgentPersonaUsage,
  importAgentPersonasWithConfirmation,
} from "@t3tools/client-runtime/j5/agent-personas";
import {
  type AgentPersonaImportConflict,
  type AgentPersonaImportConflictError,
  type AgentPersonaLibraryFolder,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Platform, Pressable, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { pickAgentDefinitions } from "./pickAgentDefinitions";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { SettingsActionRow } from "../../features/settings/components/SettingsActionRow";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { PlaybookLibrarySettingsSection } from "../playbooks/PlaybookLibrarySettingsScreen";

export function AgentLibrarySettingsScreen() {
  // Personas and Playbooks are managed by a server's Owners (People and access AC27).
  return useOwnerSomewhere() === false ? (
    <SettingsScreen title="Personas">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 pt-4"
      >
        <Text className="text-base text-foreground-muted">{LIBRARY_FOR_OWNERS}</Text>
      </ScreenScrollView>
    </SettingsScreen>
  ) : (
    <OwnerAgentLibrarySettingsScreen />
  );
}

function OwnerAgentLibrarySettingsScreen() {
  const insets = useSafeAreaInsets();
  const { connectedEnvironments: connected } = useRemoteConnectionStatus();
  const ownedEnvironmentIds = useOwnedEnvironmentIds();
  const connectedEnvironments = useMemo(
    () => connected.filter((environment) => ownedEnvironmentIds.has(environment.environmentId)),
    [connected, ownedEnvironmentIds],
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
  // oxlint-disable-next-line t3code/react-effect-budget -- a replaced or unmounted confirmation resolves its waiting import as cancelled.
  useEffect(() => () => confirmation?.resolve(null), [confirmation]);
  const navigation = usePersonaFormNavigation();
  const [notification, setNotification] = useState<AgentLibraryNotification | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
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
    const copied = await settlePromise(async () => {
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
    });
    setBusy(false);
    if (copied._tag === "Failure") setNotification(failureNotice("Persona action failed", copied));
  }
  async function saveFolders(folders: ReadonlyArray<string>) {
    if (effectiveEnvironmentId === null || busy) return;
    setBusy(true);
    const result = await setLibraryFolders({
      environmentId: effectiveEnvironmentId,
      input: { folders },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setNotification(failureNotice("Library folders not saved", result));
      return;
    }
    librarySources.refresh();
    catalog.refresh();
  }
  async function importSelection(kind: "folder" | "agent") {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    const imported = await settlePromise(async () => {
      const files = await pickAgentDefinitions(kind);
      if (files === null) return;
      const result = await importAgentPersonasWithConfirmation(
        files,
        (input) =>
          sendWhenReconnected(environmentId, async () => {
            const response = await importAgents({ environmentId, input });
            if (response._tag === "Failure") throw squashAtomCommandFailure(response);
            return response.value;
          }),
        confirmReplacement,
      );
      if (result === null) return;
      setNotification({
        type: "success",
        title: `Imported ${result.importedIds.length} persona(s).`,
      });
      catalog.refresh();
    });
    setBusy(false);
    if (imported._tag === "Failure") {
      setNotification(failureNotice("Persona action failed", imported));
    }
  }
  const setAgentEnabled = useAtomCommand(agentPersonaEnvironment.setAgentPersonaEnabled, {
    reportFailure: false,
  });
  async function toggleAgent(personaId: string, enabled: boolean) {
    if (effectiveEnvironmentId === null || busy) return;
    setBusy(true);
    const result = await setAgentEnabled({
      environmentId: effectiveEnvironmentId,
      input: { personaId, enabled },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setNotification(failureNotice("Persona action failed", result));
      return;
    }
    catalog.refresh();
  }
  async function removePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    setBusy(true);
    const result = await removeAgent({
      environmentId: effectiveEnvironmentId,
      input: { personaId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setNotification(failureNotice("Persona action failed", result));
      return;
    }
    setNotification({ type: "success", title: "Persona removed" });
    catalog.refresh();
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
    const read = await settlePromise(() => readDefinition(personaId));
    setBusy(false);
    if (read._tag === "Failure") {
      setNotification(failureNotice("Persona action failed", read));
      return;
    }
    if (effectiveEnvironmentId === null) return;
    navigation.navigate("SettingsPersonaNew", {
      environmentId: effectiveEnvironmentId,
      initial: agentPersonaDuplicateDraft(read.value.definition),
    });
  }
  async function exportPersona(personaId: string) {
    if (busy) return;
    setBusy(true);
    const shared = await settlePromise(async () => {
      const { fileName, yaml } = await readDefinition(personaId);
      await shareAgentDefinition(fileName, yaml);
    });
    setBusy(false);
    if (shared._tag === "Failure") setNotification(failureNotice("Persona action failed", shared));
  }
  async function restorePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    setBusy(true);
    const result = await restoreAgent({
      environmentId: effectiveEnvironmentId,
      input: { personaId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setNotification(failureNotice("Persona action failed", result));
      return;
    }
    setNotification({ type: "success", title: "Persona restored" });
    catalog.refresh();
  }
  const personas =
    catalog.data === null || catalog.data === undefined
      ? []
      : presentAgentPersonaCatalog(catalog.data);

  const viewedPersona = personas.find((persona) => persona.personaId === viewing);
  const folders = librarySources.data?.folders ?? [];
  const environmentLabel =
    connectedEnvironments.find(
      (environment) => environment.environmentId === effectiveEnvironmentId,
    )?.environmentLabel ?? "this environment";

  return (
    <SettingsScreen
      title="Personas"
      actions={[
        {
          accessibilityLabel: "Create persona",
          icon: "plus",
          disabled: locked || effectiveEnvironmentId === null,
          onPress: () => {
            if (effectiveEnvironmentId !== null)
              navigation.navigate("SettingsPersonaNew", { environmentId: effectiveEnvironmentId });
          },
        },
      ]}
    >
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
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {catalog.data?.diagnostics?.length ? (
          <SettingsSection title="Library errors">
            {catalog.data.diagnostics.map((diagnostic, index) => (
              <InfoRow
                key={diagnostic.path}
                borderTop={index > 0}
                tone="danger"
                text={`Invalid persona file: ${diagnostic.path}: ${diagnostic.message}`}
              />
            ))}
          </SettingsSection>
        ) : null}

        {connectedEnvironments.length > 1 ? (
          <SettingsSection title="Environment">
            <Menu
              actions={connectedEnvironments.map((environment) => ({
                id: environment.environmentId,
                title: environment.environmentLabel,
                state:
                  environment.environmentId === effectiveEnvironmentId
                    ? ("on" as const)
                    : undefined,
              }))}
              onPressAction={({ nativeEvent }) => {
                const next = connectedEnvironments.find(
                  (environment) => environment.environmentId === nativeEvent.event,
                );
                if (next && !busy) setSelectedEnvironmentId(next.environmentId);
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Environment, ${environmentLabel}`}
                className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              >
                <Text textRole="body" className="text-foreground">
                  Environment
                </Text>
                <Text
                  textRole="footnote"
                  className="min-w-0 flex-1 text-right text-foreground-muted"
                  numberOfLines={1}
                >
                  {environmentLabel}
                </Text>
                <SymbolView
                  name="chevron.down"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
            </Menu>
          </SettingsSection>
        ) : null}

        <SettingsSection
          title="Personas"
          footer={
            Platform.OS === "web"
              ? "Use Settings → Personas in the web app to import files."
              : "In a Codex or Claude conversation, type @persona:id, or @ and the start of a persona’s name, to run a persona as a subagent."
          }
        >
          {effectiveEnvironmentId === null ? (
            <InfoRow text="No connected environments" />
          ) : catalog.isPending ? (
            <InfoRow text="Loading personas" />
          ) : catalog.error ? (
            <InfoRow tone="danger" text={catalog.error} />
          ) : personas.length === 0 ? (
            <InfoRow text="No personas in this library" />
          ) : (
            personas.map((persona, index) => (
              <PersonaRow
                key={persona.personaId}
                persona={persona}
                borderTop={index > 0}
                locked={locked}
                busy={busy}
                otherEnvironments={otherEnvironments}
                onToggle={(enabled) => void toggleAgent(persona.personaId, enabled)}
                onEdit={
                  persona.edit && effectiveEnvironmentId && canOperate
                    ? () => {
                        if (persona.edit && effectiveEnvironmentId)
                          navigation.navigate("SettingsPersonaEdit", {
                            environmentId: effectiveEnvironmentId,
                            initial: persona.edit,
                          });
                      }
                    : null
                }
                onDetails={() => setViewing(persona.personaId)}
                onDuplicate={() => void duplicatePersona(persona.personaId)}
                onExport={() => void exportPersona(persona.personaId)}
                onCopy={(target) => void copyPersona(persona.personaId, target)}
                onRemove={() => void removePersona(persona.personaId)}
                onRestore={() => void restorePersona(persona.personaId)}
              />
            ))
          )}
          {Platform.OS === "web" || effectiveEnvironmentId === null ? null : (
            <>
              <View className="border-t border-border-subtle" />
              <SettingsActionRow
                icon="doc.text"
                label="Import persona file"
                disabled={locked}
                onPress={() => void importSelection("agent")}
              />
              <View className="border-t border-border-subtle" />
              <SettingsActionRow
                icon="folder"
                label="Import a folder of personas"
                disabled={locked}
                onPress={() => void importSelection("folder")}
              />
            </>
          )}
        </SettingsSection>

        {effectiveEnvironmentId !== null ? (
          <SettingsSection
            title="Library sources"
            footer={
              librarySources.data?.configured === false
                ? "Folders this environment reads YAML definitions from, on its machine. Bundled examples appear until a folder is configured or the default folder exists. Adding a folder writes agent-personas.json."
                : "Folders this environment reads YAML definitions from, on its machine; relative paths resolve from its state directory. Files are read on every catalog request, so edits and git pulls apply without a restart."
            }
          >
            {librarySources.isPending ? (
              <InfoRow text="Loading folders" />
            ) : librarySources.error ? (
              <InfoRow tone="danger" text={librarySources.error} />
            ) : folders.length === 0 ? (
              <InfoRow text="No source folders. Only personal and imported personas are available." />
            ) : (
              folders.map((folder, index) => (
                <FolderRow
                  key={folder.configuredPath}
                  folder={folder}
                  configured={librarySources.data?.configured}
                  borderTop={index > 0}
                  locked={locked}
                  onRemove={() =>
                    void saveFolders(
                      folders
                        .map(({ configuredPath }) => configuredPath)
                        .filter((candidate) => candidate !== folder.configuredPath),
                    )
                  }
                />
              ))
            )}
            <View className="border-t border-border-subtle" />
            <SettingsActionRow
              icon="plus"
              label="Add folder"
              disabled={locked}
              onPress={() => setPickingFolder(true)}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection title="Playbooks">
          <PlaybookLibrarySettingsSection environmentId={effectiveEnvironmentId} />
        </SettingsSection>
      </ScreenScrollView>
      {notification ? (
        <AgentLibraryToast notification={notification} onDismiss={dismissNotification} />
      ) : null}
      {pickingFolder && effectiveEnvironmentId ? (
        <AgentFolderPickerModal
          environmentId={effectiveEnvironmentId}
          environmentLabel={environmentLabel}
          onClose={() => setPickingFolder(false)}
          onSelect={(path) => {
            setPickingFolder(false);
            void saveFolders([...folders.map(({ configuredPath }) => configuredPath), path]);
          }}
        />
      ) : null}
      {viewedPersona && effectiveEnvironmentId ? (
        <AgentDetailsModal
          key={`${effectiveEnvironmentId}:${viewedPersona.personaId}`}
          environmentId={effectiveEnvironmentId}
          persona={viewedPersona}
          usageLine={(() => {
            const entry = usageById.get(viewedPersona.personaId);
            return entry === undefined ? null : presentAgentPersonaUsage(entry).line;
          })()}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </SettingsScreen>
  );
}

function failureNotice(
  title: string,
  result: Parameters<typeof squashAtomCommandFailure>[0],
): AgentLibraryNotification {
  const error = squashAtomCommandFailure(result);
  return {
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Native platforms share a real .yaml file; the web build falls back to sharing the text. Kept
 * outside the screen because the React Compiler skips a component that holds `import()`.
 */
async function shareAgentDefinition(fileName: string, yaml: string) {
  if (Platform.OS === "web") {
    await Share.share({ title: fileName, message: yaml });
    return;
  }
  const [FileSystem, Sharing] = await Promise.all([
    import("expo-file-system/legacy"),
    import("expo-sharing"),
  ]);
  const uri = `${FileSystem.cacheDirectory ?? ""}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, yaml);
  await Sharing.shareAsync(uri, { mimeType: "application/yaml", dialogTitle: fileName });
}

function InfoRow(props: {
  readonly text: string;
  readonly tone?: "danger";
  readonly borderTop?: boolean;
}) {
  return (
    <View className={cn("px-4 py-3", props.borderTop && "border-t border-border-subtle")}>
      <Text
        className={cn(
          "text-base",
          props.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
        )}
      >
        {props.text}
      </Text>
    </View>
  );
}

type PresentedPersona = ReturnType<typeof presentAgentPersonaCatalog>[number];

/** One persona as a settings row: name and status, its switch, and the rest in a menu. */
function PersonaRow(props: {
  readonly persona: PresentedPersona;
  readonly borderTop: boolean;
  readonly locked: boolean;
  readonly busy: boolean;
  readonly otherEnvironments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly onToggle: (enabled: boolean) => void;
  readonly onEdit: (() => void) | null;
  readonly onDetails: () => void;
  readonly onDuplicate: () => void;
  readonly onExport: () => void;
  readonly onCopy: (target: { environmentId: EnvironmentId; label: string }) => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}) {
  const { persona } = props;
  const unavailable = !persona.removed && persona.availability !== "available";
  const actions = personaRowActions(
    { removed: persona.removed, editable: props.onEdit !== null },
    props.otherEnvironments.length > 0,
  );
  const onEdit = actions.includes("edit") ? props.onEdit : null;
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2 pl-4 pr-1",
        props.borderTop && "border-t border-border-subtle",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          onEdit ? `Edit ${persona.displayName}` : `Details for ${persona.displayName}`
        }
        accessibilityHint={persona.description}
        disabled={props.busy}
        onPress={onEdit ?? props.onDetails}
        className="min-w-0 flex-1 gap-0.5 py-1 active:opacity-70"
      >
        <Text
          textRole="body"
          className={
            persona.enabled && !persona.removed ? "text-foreground" : "text-foreground-muted"
          }
          numberOfLines={1}
        >
          {persona.displayName}
        </Text>
        {persona.removed ? <Text className="text-sm text-foreground-muted">Removed</Text> : null}
        {unavailable && persona.blockedReasons[0] ? (
          <Text className="text-sm text-danger-foreground" numberOfLines={2}>
            {persona.blockedReasons[0]}
          </Text>
        ) : null}
      </Pressable>
      {persona.removed ? null : (
        <ThemedSwitch
          // React Native's Switch sets alignSelf: flex-start, which ignores the row's centring.
          style={{ alignSelf: "center" }}
          value={persona.enabled}
          disabled={props.locked}
          accessibilityLabel={`Enable ${persona.displayName}`}
          onValueChange={props.onToggle}
        />
      )}
      <Menu
        actions={actions.map((action) => {
          switch (action) {
            case "edit":
              return { id: action, title: "Edit", attributes: { disabled: props.locked } };
            case "details":
              return { id: action, title: "Details" };
            case "duplicate":
              return {
                id: action,
                title: "Duplicate as personal persona",
                attributes: { disabled: props.locked || persona.availability === "unsupported" },
              };
            case "export":
              return { id: action, title: "Export YAML", attributes: { disabled: props.busy } };
            case "copy":
              return {
                id: action,
                title: "Copy to environment",
                attributes: { disabled: props.busy },
                subactions: props.otherEnvironments.map((environment) => ({
                  id: `copy:${environment.environmentId}`,
                  title: environment.environmentLabel,
                })),
              };
            case "remove":
              return {
                id: action,
                title: "Remove",
                attributes: { destructive: true, disabled: props.locked },
              };
            case "restore":
              return { id: action, title: "Restore", attributes: { disabled: props.locked } };
          }
        })}
        onPressAction={({ nativeEvent }) => {
          const action = nativeEvent.event;
          if (action === "edit") onEdit?.();
          else if (action === "details") props.onDetails();
          else if (action === "duplicate") props.onDuplicate();
          else if (action === "export") props.onExport();
          else if (action === "remove") props.onRemove();
          else if (action === "restore") props.onRestore();
          else if (action.startsWith("copy:")) {
            const target = props.otherEnvironments.find(
              (environment) => `copy:${environment.environmentId}` === action,
            );
            if (target)
              props.onCopy({ environmentId: target.environmentId, label: target.environmentLabel });
          }
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${persona.displayName}`}
          className="size-11 items-center justify-center"
        >
          <SymbolView
            name="ellipsis"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}

/** One source folder: its path on one line, its status, git nudges, and a menu to stop reading it. */
function FolderRow(props: {
  readonly folder: AgentPersonaLibraryFolder;
  readonly configured: boolean | undefined;
  readonly borderTop: boolean;
  readonly locked: boolean;
  readonly onRemove: () => void;
}) {
  const { folder } = props;
  const nudges = agentPersonaFolderNudges(folder.git);
  const missing = !folder.exists && props.configured !== false;
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2 pl-4 pr-1",
        props.borderTop && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5 py-1">
        <Text textRole="body" className="text-foreground" numberOfLines={1} ellipsizeMode="middle">
          {folder.configuredPath}
        </Text>
        {folder.path !== folder.configuredPath ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">
            {folder.path}
          </Text>
        ) : null}
        <Text
          className={cn("text-sm", missing ? "text-danger-foreground" : "text-foreground-muted")}
        >
          {agentPersonaFolderStatusLabel(folder, props.configured)}
        </Text>
        {nudges.map((nudge) => (
          <Text key={nudge} className="text-sm text-foreground">
            {nudge}
          </Text>
        ))}
      </View>
      <Menu
        actions={[
          {
            id: "remove",
            title: "Stop reading this folder",
            attributes: { destructive: true, disabled: props.locked },
          },
        ]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "remove") props.onRemove();
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Actions for ${folder.configuredPath}`}
          className="size-11 items-center justify-center"
        >
          <SymbolView
            name="ellipsis"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}
