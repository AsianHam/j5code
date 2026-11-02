import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { playbookStepLabel } from "@t3tools/client-runtime/j5/playbooks";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { PlaybookSource } from "@t3tools/contracts/j5";
import { useCallback, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Share, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { AgentFolderPickerModal } from "../agents/AgentFolderPickerModal";
import { useOwnedEnvironmentIds } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { useSettingsFormNavigation } from "../agents/SettingsFormScreen";

export function PlaybookLibrarySettingsSection({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // Playbooks are managed on the servers the person owns (People and access AC27).
  const owned = useOwnedEnvironmentIds();
  const environments = connectedEnvironments.filter((entry) => owned.has(entry.environmentId));
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return environment ? (
    <PlaybookLibrary
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.environmentLabel}
      environments={environments.map((entry) => ({
        environmentId: entry.environmentId,
        label: entry.environmentLabel,
      }))}
    />
  ) : (
    <Text className="p-4 text-foreground-muted">No environment connected.</Text>
  );
}

function PlaybookLibrary({
  environmentId,
  label,
  environments,
}: {
  environmentId: EnvironmentId;
  label: string;
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
}) {
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  // A project's .j5/playbooks files join the list and win over a same-named library copy.
  const scope = project ? { projectId: project.id } : {};
  const query = useEnvironmentQuery(j5Environment.playbookLibrary({ environmentId, input: scope }));
  const sources = useEnvironmentQuery(j5Environment.playbookSources({ environmentId, input: {} }));
  const canOperate = useAtomValue(j5Environment.savePlaybook.permissionAtom(environmentId));
  const save = useAtomCommand(j5Environment.savePlaybook, { reportFailure: false });
  const setFolders = useAtomCommand(j5Environment.setPlaybookFolders, { reportFailure: false });
  const exportDefinition = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const remove = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const rename = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigation = useSettingsFormNavigation();
  const openConversation = (playbook: string | null) =>
    navigation.navigate("SettingsPlaybookConversation", {
      environmentId,
      name: playbook,
      projectId: project?.id ?? null,
    });
  const [details, setDetails] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState<{
    name: string;
    destination: EnvironmentId;
    source: PlaybookSource;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    name: string;
    title: string;
    source: PlaybookSource;
  } | null>(null);
  const canSaveDestination = useAtomValue(
    j5Environment.savePlaybook.permissionAtom(copyTarget?.destination ?? environmentId),
  );
  const folderPaths = (sources.data?.folders ?? []).flatMap((entry) =>
    entry.source.kind === "folder" ? [entry.source.path] : [],
  );
  const detail = query.data?.playbooks.find((entry) => entry.name === details);
  const { refresh } = query;
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await settlePromise(operation);
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Playbook action failed.");
      return;
    }
    query.refresh();
    sources.refresh();
  }
  async function changeFolders(folders: string[]) {
    const result = await setFolders({ environmentId, input: { folders } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }
  const closeEditor = () => {
    if (!busy) {
      setImporting(false);
      setCopyTarget(null);
      setRenameTarget(null);
      setName("");
      setYaml("");
      setError(null);
    }
  };
  return (
    <>
      <View className="flex-row items-center justify-between gap-3 p-4">
        {projects.length > 0 ? (
          <Menu
            actions={[
              { id: "", title: "Library only", state: project ? "off" : "on" },
              ...projects.map((entry) => ({
                id: entry.id,
                title: entry.title,
                state: entry.id === project?.id ? ("on" as const) : ("off" as const),
              })),
            ]}
            onPressAction={({ nativeEvent }) =>
              setProjectId(nativeEvent.event ? (nativeEvent.event as ProjectId) : null)
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Project playbooks"
              className="flex-1"
            >
              <Text className="text-sm text-foreground">{project?.title ?? "Library only"} ▾</Text>
            </Pressable>
          </Menu>
        ) : (
          <Text className="flex-1 text-sm text-foreground-muted">Available in every project.</Text>
        )}
        <Menu
          actions={[
            {
              id: "create",
              title: "Create playbook",
              attributes: { disabled: busy || !canOperate },
            },
            { id: "import", title: "Import YAML", attributes: { disabled: busy || !canOperate } },
            {
              id: "folder",
              title: "Add source folder",
              attributes: { disabled: busy || !canOperate || !sources.data },
            },
            { id: "refresh", title: "Refresh", attributes: { disabled: busy } },
          ]}
          onPressAction={({ nativeEvent }) => {
            const action = nativeEvent.event;
            if (action === "create") openConversation(null);
            else if (action === "import") {
              setError(null);
              setImporting(true);
            } else if (action === "folder") setPicking(true);
            else {
              query.refresh();
              sources.refresh();
            }
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Playbook library actions">
            <Text className="text-primary">Add / manage</Text>
          </Pressable>
        </Menu>
      </View>
      {project ? (
        <Text className="px-4 pb-3 text-xs text-foreground-muted">
          Includes {project.title}'s .j5/playbooks folder. Those override a library playbook with
          the same name in that project.
        </Text>
      ) : null}
      {error || sources.error || query.error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
          {error ?? sources.error ?? query.error}
        </Text>
      ) : null}
      {query.isPending && !query.data ? <Text className="p-4">Loading playbooks…</Text> : null}
      {query.data?.playbooks.length === 0 ? (
        <View className="gap-1 p-4">
          <Text className="text-foreground">No playbooks yet</Text>
          <Text className="text-sm text-foreground-muted">
            Create a repeatable workflow with your agent, or import YAML.
          </Text>
        </View>
      ) : null}
      {query.data?.playbooks.map((playbook) => {
        const source = playbook.source ?? { kind: "environment" };
        return (
          <View key={playbook.name} className="gap-2 border-t border-border p-4">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 font-semibold text-foreground">{playbook.title}</Text>
              <Menu
                actions={[
                  {
                    id: "chat",
                    title: "Prepare chat",
                    attributes: { disabled: busy || !!playbook.issue },
                  },
                  { id: "steps", title: "View steps", attributes: { disabled: !!playbook.issue } },
                  {
                    id: "export",
                    title: "Export YAML",
                    attributes: { disabled: busy || !!playbook.issue },
                  },
                  {
                    id: "rename",
                    title:
                      source.kind === "folder"
                        ? "Rename unavailable: edit source folder"
                        : "Rename",
                    attributes: {
                      disabled: busy || !canOperate || source.kind === "folder" || !!playbook.issue,
                    },
                  },
                  ...environments
                    .filter(
                      (entry) =>
                        entry.environmentId !== environmentId || source.kind !== "environment",
                    )
                    .map((entry) => ({
                      id: `copy:${entry.environmentId}`,
                      title:
                        entry.environmentId === environmentId
                          ? "Copy to library"
                          : `Copy to ${entry.label}`,
                      attributes: { disabled: busy || !!playbook.issue },
                    })),
                  {
                    id: "delete",
                    title:
                      source.kind === "folder"
                        ? "Delete unavailable: edit source folder"
                        : "Delete",
                    attributes: { disabled: busy || !canOperate || source.kind === "folder" },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  const action = nativeEvent.event;
                  if (action === "chat") openConversation(playbook.name);
                  else if (action === "steps") setDetails(playbook.name);
                  else if (action.startsWith("copy:")) {
                    const destination = environments.find(
                      (entry) => `copy:${entry.environmentId}` === action,
                    );
                    if (destination) {
                      setError(null);
                      setName(playbook.name);
                      setCopyTarget({
                        name: playbook.name,
                        source,
                        destination: destination.environmentId,
                      });
                    }
                  } else if (action === "rename") {
                    setError(null);
                    setRenameTarget({ name: playbook.name, title: playbook.title, source });
                  } else if (action === "export")
                    void act(async () => {
                      const result = await exportDefinition({
                        environmentId,
                        input: { ...scope, name: playbook.name, source },
                      });
                      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      await Share.share({
                        title: result.value.fileName,
                        message: result.value.yaml,
                      });
                    });
                  else if (action === "delete")
                    Alert.alert("Delete playbook", `Delete ${playbook.title}?`, [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () =>
                          void act(async () => {
                            const result = await remove({
                              environmentId,
                              input: { ...scope, name: playbook.name, source },
                            });
                            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                          }),
                      },
                    ]);
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`More actions for ${playbook.title}`}
                >
                  <Text className="text-foreground-muted">•••</Text>
                </Pressable>
              </Menu>
            </View>
            <Text className="text-sm text-foreground-muted">{playbook.description}</Text>
            <Text className="text-xs text-foreground-muted">
              {playbook.stepCount} {playbook.stepCount === 1 ? "step" : "steps"}
              {source.kind === "folder" ? " · From source folder" : ""}
              {source.kind === "workspace" ? ` · From ${project?.title ?? "project"}` : ""}
              {playbook.overridesLibrary ? " · Overrides library copy" : ""}
            </Text>
            {playbook.issue ? (
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {playbook.issue.message}
              </Text>
            ) : null}
            {(playbook.warnings ?? []).map((warning) => (
              <Text
                accessibilityRole="alert"
                key={`${warning.stepId}:${warning.code}`}
                className="text-warning-foreground"
              >
                {warning.message}
              </Text>
            ))}
          </View>
        );
      })}
      {sources.data?.folders
        .filter((entry) => entry.source.kind === "folder" || entry.issue)
        .map((entry) => (
          <View key={entry.path} className="gap-2 border-t border-border p-4">
            <Text className="text-sm text-foreground-muted">
              {entry.source.kind === "folder" ? entry.path : "Environment library"}
            </Text>
            {entry.issue ? (
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {entry.issue.message}
              </Text>
            ) : null}
            {entry.source.kind === "folder" ? (
              <Pressable
                accessibilityRole="button"
                disabled={!canOperate || busy}
                onPress={() =>
                  void act(() =>
                    changeFolders(
                      folderPaths.filter(
                        (folder) => entry.source.kind !== "folder" || folder !== entry.source.path,
                      ),
                    ),
                  )
                }
              >
                <Text className="text-primary">Remove source</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      {picking ? (
        <AgentFolderPickerModal
          environmentId={environmentId}
          environmentLabel={label}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setPicking(false);
            void act(() => changeFolders([...folderPaths, path]));
          }}
        />
      ) : null}
      {detail ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setDetails(null)}
        >
          {/* SafeAreaView takes no className, so the theme surface and flex go on a View. */}
          <View className="flex-1 bg-sheet">
            <SafeAreaView style={{ flex: 1 }}>
              <ScrollView contentContainerClassName="gap-3 p-4">
                <Text className="text-xl font-semibold text-foreground">{detail.title}</Text>
                <Text className="text-foreground-muted">{detail.description}</Text>
                {detail.steps.map((step, index) => (
                  <Text key={step.id}>{playbookStepLabel(step, index)}</Text>
                ))}
                <Pressable accessibilityRole="button" onPress={() => setDetails(null)}>
                  <Text className="text-primary">Close</Text>
                </Pressable>
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      ) : null}
      {importing || copyTarget || renameTarget ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={closeEditor}
        >
          {/* SafeAreaView takes no className, so the theme surface and flex go on a View. */}
          <View className="flex-1 bg-sheet">
            <SafeAreaView style={{ flex: 1 }}>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4">
                <Text className="text-xl font-semibold text-foreground">
                  {renameTarget
                    ? "Rename playbook"
                    : copyTarget
                      ? "Copy playbook"
                      : "Import playbook"}
                </Text>
                <Text className="text-foreground-muted">
                  Available in every project on the environment.
                </Text>
                <TextInput
                  accessibilityLabel={renameTarget ? "Playbook title" : "Playbook name"}
                  placeholder={renameTarget ? "Title" : "release-review"}
                  value={renameTarget ? renameTarget.title : name}
                  onChangeText={(value) =>
                    renameTarget
                      ? setRenameTarget({ ...renameTarget, title: value })
                      : setName(value)
                  }
                  editable={!busy}
                  autoCapitalize="none"
                  className="rounded-lg border border-border p-3 text-foreground"
                />
                {importing ? (
                  <TextInput
                    accessibilityLabel="Playbook YAML"
                    placeholder="Paste YAML"
                    value={yaml}
                    onChangeText={setYaml}
                    editable={!busy}
                    multiline
                    className="min-h-48 rounded-lg border border-border p-3 text-foreground"
                  />
                ) : null}
                {error ? (
                  <Text accessibilityRole="alert" className="text-danger-foreground">
                    {error}
                  </Text>
                ) : null}
                <View className="flex-row justify-end gap-4">
                  <Pressable accessibilityRole="button" disabled={busy} onPress={closeEditor}>
                    <Text>Cancel</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      busy ||
                      !canSaveDestination ||
                      (renameTarget
                        ? !renameTarget.title.trim()
                        : !name.trim() || (importing && !yaml.trim()))
                    }
                    onPress={() =>
                      void act(async () => {
                        if (renameTarget) {
                          const result = await rename({
                            environmentId,
                            input: { ...scope, ...renameTarget, title: renameTarget.title.trim() },
                          });
                          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                          setRenameTarget(null);
                        } else {
                          let text = yaml;
                          if (copyTarget) {
                            const result = await exportDefinition({
                              environmentId,
                              input: { ...scope, name: copyTarget.name, source: copyTarget.source },
                            });
                            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                            text = result.value.yaml;
                          }
                          const result = await save({
                            environmentId: copyTarget?.destination ?? environmentId,
                            input: { name, yaml: text },
                          });
                          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                          setImporting(false);
                          setCopyTarget(null);
                          setName("");
                          setYaml("");
                        }
                      })
                    }
                  >
                    <Text className="text-primary">
                      {renameTarget ? "Save" : copyTarget ? "Copy" : "Import"}
                    </Text>
                  </Pressable>
                </View>
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      ) : null}
    </>
  );
}
