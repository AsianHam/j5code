import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";

function browsePlatform(os: string | null | undefined): string {
  return os === "windows" ? "Win32" : os === "darwin" ? "MacIntel" : "Linux";
}

/** Browse the environment's folders (never the phone's) and choose one for the library. */
export function AgentFolderPickerModal(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onSelect: (path: string) => void;
}) {
  const serverConfig = useServerConfigs().get(props.environmentId);
  const platform = browsePlatform(serverConfig?.environment.platform.os);
  const [pathInput, setPathInput] = useState(() =>
    getAddProjectInitialQuery(serverConfig?.settings.addProjectBaseDirectory),
  );
  const browsePath = useMemo(
    () => getFilesystemBrowsePath(pathInput, platform),
    [pathInput, platform],
  );
  const browseState = useEnvironmentQuery(
    browsePath.directoryPath.length === 0
      ? null
      : filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath },
        }),
  );
  const { visibleEntries, exactEntry } = useMemo(
    () => filterFilesystemBrowseEntries(browseState.data?.entries ?? [], browsePath.filterQuery),
    [browsePath.filterQuery, browseState.data?.entries],
  );
  const selection = exactEntry?.fullPath ?? browseState.data?.parentPath ?? null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView className="flex-1 bg-sheet">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center justify-between px-5 py-3">
            <Text className="text-xl font-t3-semibold">Choose a library folder</Text>
            <Pressable accessibilityRole="button" onPress={props.onClose} className="px-3 py-2">
              <Text>Cancel</Text>
            </Pressable>
          </View>
          <View className="gap-3 px-5 pb-3">
            <Text className="text-sm text-foreground-muted">
              Folders on {props.environmentLabel}. Open a folder to browse into it, then choose it.
            </Text>
            <TextInput
              accessibilityLabel="Folder path"
              autoCapitalize="none"
              autoCorrect={false}
              value={pathInput}
              onChangeText={setPathInput}
            />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            className="flex-1"
            contentContainerClassName="gap-1 px-5 pb-4"
          >
            {browsePath.canBrowseUp && browsePath.parentPath ? (
              <FolderRow
                label=".."
                symbol="arrow.turn.left.up"
                onPress={() => setPathInput(browsePath.parentPath!)}
              />
            ) : null}
            {browseState.error ? (
              <Text className="px-2 py-2 text-sm text-danger-foreground">{browseState.error}</Text>
            ) : browseState.isPending && browseState.data === null ? (
              <View className="items-center py-5">
                <ActivityIndicator />
              </View>
            ) : visibleEntries.length === 0 ? (
              <Text className="px-2 py-2 text-sm text-foreground-muted">No subfolders.</Text>
            ) : (
              visibleEntries.map((entry) => (
                <FolderRow
                  key={entry.fullPath}
                  label={entry.name}
                  symbol="folder"
                  selected={entry.fullPath === selection}
                  onPress={() =>
                    setPathInput(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                  }
                />
              ))
            )}
          </ScrollView>
          <View className="gap-2 px-5 pb-4">
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {selection ?? "Enter a folder path to browse."}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: selection === null }}
              disabled={selection === null}
              className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40"
              onPress={() => selection && props.onSelect(selection)}
            >
              <Text className="font-t3-semibold text-primary-foreground">Choose folder</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function FolderRow(props: {
  readonly label: string;
  readonly symbol: "folder" | "arrow.turn.left.up";
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label === ".." ? "Parent folder" : props.label}
      accessibilityState={{ selected: props.selected ?? false }}
      className={`flex-row items-center gap-3 rounded-xl px-3 py-3 ${props.selected ? "bg-primary/10" : "bg-card"}`}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.symbol}
        size={17}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}
