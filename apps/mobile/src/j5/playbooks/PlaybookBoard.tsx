import { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { j5Environment } from "../state";
import { usePlaybookRefresh } from "./usePlaybookRefresh";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";

const stepColor = {
  current: "bg-primary",
  last: "bg-foreground-muted/60",
  earlier: "bg-primary/35",
  later: "bg-subtle-strong",
  available: "bg-subtle-strong",
};

export function PlaybookBoard(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
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
  const [expanded, setExpanded] = useState(true);
  const [showSteps, setShowSteps] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
  const run = runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
  if (!run) return null;
  const display = presentPlaybook(run);
  return (
    <View
      className="border-b border-border bg-card px-4 py-3"
      accessibilityLabel="Playbook progress"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="font-semibold text-foreground">{run.title}</Text>
        <Text className="mt-1 text-xs text-foreground-muted">
          {display.status} · {display.position} · {display.currentTitle}
        </Text>
      </Pressable>
      {expanded && (
        <>
          {runs.length > 1 && (
            <ScrollView horizontal className="mt-2" accessibilityLabel="Playbook runs">
              {runs.map((entry, index) => (
                <Pressable
                  key={entry.runId}
                  accessibilityRole="button"
                  accessibilityState={{ selected: entry.runId === run.runId }}
                  onPress={() => setSelectedRunId(entry.runId)}
                  className="mr-3 rounded border border-border p-2"
                >
                  <Text className="text-xs text-foreground">
                    {index === 0 ? "Latest" : entry.title} · {entry.status}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          {query.error && (
            <Text accessibilityRole="alert" className="mt-2 text-xs text-foreground-muted">
              Progress could not refresh. Showing the last received state.
            </Text>
          )}
          {run.issue && (
            <Text accessibilityRole="alert" className="mt-2 text-xs text-foreground-muted">
              {run.issue.message}
            </Text>
          )}
          {display.steps.length > 0 && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${showSteps ? "Hide" : "Show"} all ${display.steps.length} steps`}
                accessibilityState={{ expanded: showSteps }}
                onPress={() => setShowSteps(!showSteps)}
                className="mt-2 min-h-11 justify-center gap-2 py-2"
              >
                <View
                  className="flex-row gap-px"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  {display.steps.map((step) => (
                    <View
                      key={step.id}
                      className={`h-2 min-w-0 flex-1 rounded-sm ${stepColor[step.state]}`}
                    />
                  ))}
                </View>
                <Text className="text-xs text-foreground-muted">
                  {showSteps ? "Hide steps" : "Show steps"}
                </Text>
              </Pressable>
              {showSteps && (
                <ScrollView
                  className="max-h-48"
                  nestedScrollEnabled
                  accessibilityLabel="Playbook steps"
                >
                  {display.steps.map((step, index) => (
                    <Text
                      key={step.id}
                      accessibilityLabel={`${index + 1}. ${step.title}, ${step.label}`}
                      className={`py-1 text-sm ${step.current ? "font-t3-medium text-foreground" : "text-foreground-muted"}`}
                    >
                      {index + 1} · {step.title}
                      {(step.current || step.state === "last") && ` · ${step.label}`}
                    </Text>
                  ))}
                </ScrollView>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
