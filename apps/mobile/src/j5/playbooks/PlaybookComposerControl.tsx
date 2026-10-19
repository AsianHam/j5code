import {
  type PlaybookStagesView,
  playbookRunSelection,
  playbookStagesView,
  presentPlaybookStages,
  rememberPlaybookStagesView,
  selectedPlaybookRun,
} from "@t3tools/client-runtime/j5/playbooks";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { j5Environment } from "../state";
import { usePlaybookRefresh } from "./usePlaybookRefresh";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";

export function PlaybookComposerControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const focused = useIsFocused();
  const runtime = useRemoteEnvironmentRuntime(props.environmentId);
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  // A guest is shown none of a server's Playbooks (Shared server AC24), so none is read.
  const guest = useGuestEnvironmentIds().has(props.environmentId);
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const supported = !guest && j5LedgerSupported(serverConfig) !== false;
  const query = useEnvironmentQuery(
    supported
      ? j5Environment.playbooks({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  // The thread screen unmounts this bar while a question or approval is pending.
  const viewKey = `${props.environmentId}:${props.threadId}`;
  const [view, setViewState] = useState(() => playbookStagesView(viewKey));
  const setView = (next: PlaybookStagesView) => {
    rememberPlaybookStagesView(viewKey, next);
    setViewState(next);
  };
  const { expanded } = view;
  const changes = useEnvironmentQuery(
    focused && query.data
      ? j5Environment.playbookChanges({ environmentId: props.environmentId, input: {} })
      : null,
  );
  usePlaybookRefresh({
    focused,
    connected: runtime?.connectionState === "connected",
    supported,
    isPending: query.isPending,
    refreshKey: `${thread?.latestRun?.runId}:${thread?.latestRun?.status}:${changes.data}`,
    refresh: query.refresh,
  });
  const runs = query.data?.runs ?? [];
  const run = selectedPlaybookRun(runs, view.selectedRunId);
  if (!run) return null;
  const display = presentPlaybookStages(run);
  return (
    <View className="px-4 pb-2" accessibilityLabel="Playbook progress">
      <View className="rounded-[20px] border-continuous bg-card px-3 py-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${run.title}. ${display.status}. ${display.position}. ${display.currentTitle}${query.error ? ". Progress out of date" : ""}${run.runId !== runs[0]?.runId ? ". Earlier run" : ""}`}
          onPress={() => setView({ ...view, expanded: !expanded })}
          className="min-h-11 flex-row items-center gap-2"
        >
          <SymbolView
            name={run.issue || query.error ? "exclamationmark.triangle" : "doc.text"}
            size={14}
            tintColorClassName="accent-icon-muted"
          />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs text-foreground">
              {run.title}
            </Text>
            {(run.status !== "active" ||
              run.issue ||
              query.error ||
              run.runId !== runs[0]?.runId) && (
              <Text className="text-xs text-foreground-muted">
                {run.runId !== runs[0]?.runId ? "Earlier run · " : ""}
                {query.error ? "Out of date" : display.status}
              </Text>
            )}
          </View>
          <View className="items-end gap-1">
            <Text
              className={`text-xs ${run.status === "completed" ? "text-adaptive-emerald-600-400" : "text-foreground-muted"}`}
            >
              {display.completedSteps}/{run.total}
            </Text>
            {display.steps.length > 1 && display.steps.length <= 10 && (
              <View
                className="w-10 flex-row gap-0.5"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {display.steps.map((step) => (
                  <View
                    key={step.id}
                    className={`h-[3px] min-w-0 flex-1 rounded-full ${
                      step.status === "completed"
                        ? "bg-adaptive-emerald-600-400"
                        : step.status === "inProgress"
                          ? "bg-primary"
                          : "bg-foreground-muted/25"
                    }`}
                  />
                ))}
              </View>
            )}
          </View>
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
        {expanded && (
          <ScrollView className="max-h-48" nestedScrollEnabled accessibilityLabel="Playbook stages">
            {runs.length > 1 && (
              <ScrollView horizontal className="my-2" accessibilityLabel="Playbook runs">
                {runs.map((entry, index) => (
                  <Pressable
                    key={entry.runId}
                    accessibilityRole="button"
                    accessibilityState={{ selected: entry.runId === run.runId }}
                    onPress={() =>
                      setView({ ...view, selectedRunId: playbookRunSelection(runs, entry.runId) })
                    }
                    className="mr-3 min-h-11 justify-center rounded border border-border p-2"
                  >
                    <Text className="text-xs text-foreground">
                      {index === 0 ? "Latest: " : ""}
                      {entry.title} · {entry.status} · {new Date(entry.createdAt).toLocaleString()}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            {query.error && (
              <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
                Progress could not refresh. Showing the last received state.
              </Text>
            )}
            {run.issue && (
              <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
                {run.issue.message}
              </Text>
            )}
            {display.steps.map((step, index) => (
              <View
                key={step.id}
                accessible
                accessibilityLabel={`${index + 1}. ${step.title}, ${step.label}`}
                className="flex-row items-start gap-2 py-1"
              >
                <View className="h-4 w-6 items-center justify-center">
                  {step.status === "inProgress" ? (
                    <View className="size-3 items-center justify-center rounded-full border border-primary">
                      <View className="size-1 rounded-full bg-primary" />
                    </View>
                  ) : (
                    <View className={step.status === "completed" ? undefined : "opacity-40"}>
                      <SymbolView
                        name={step.status === "completed" ? "checkmark" : "circle"}
                        size={12}
                        tintColorClassName={
                          step.status === "completed"
                            ? "accent-adaptive-emerald-600-400"
                            : "accent-foreground-muted"
                        }
                      />
                    </View>
                  )}
                </View>
                <Text
                  className={`min-w-0 flex-1 text-xs ${step.status === "completed" ? "text-foreground-muted/55" : step.status === "inProgress" ? "text-foreground/90" : "text-foreground-muted/70"}`}
                >
                  {index + 1}. {step.title}
                </Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
