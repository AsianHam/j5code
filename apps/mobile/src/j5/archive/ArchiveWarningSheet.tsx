import {
  ARCHIVE_WARNING_WORKSPACE_NOTE,
  archiveWarningAskHeader,
  archiveWarningSeatConsequences,
  sentenceEnd,
  type ArchiveWarning,
  type ArchiveWarningPayload,
  type ArchiveWarningRow,
} from "@t3tools/client-runtime/j5/archive-flow";
import { useSyncExternalStore } from "react";
import { Modal, Platform, ScrollView, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { relativeTime } from "../../lib/time";
import { asksByUrgency } from "./archiveWarningOrder";

interface Presented {
  readonly warning: ArchiveWarning;
  readonly resolve: (confirmed: boolean) => void;
}

// Archive doors run outside React, so the request lives in the module and the host renders it.
let presented: Presented | null = null;
const listeners = new Set<() => void>();

function setPresented(next: Presented | null) {
  presented = next;
  for (const listener of listeners) listener();
}

/** Shows every measured fact and resolves true only when the person confirms. */
export function presentArchiveWarning(warning: ArchiveWarning): Promise<boolean> {
  presented?.resolve(false);
  return new Promise((resolve) => setPresented({ warning, resolve }));
}

function answer(confirmed: boolean) {
  const current = presented;
  if (current === null) return;
  setPresented(null);
  current.resolve(confirmed);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getPresented = () => presented;

const URGENCY_LABELS = { blocking: "BLOCKING", soon: "SOON", fyi: "FYI", none: "NO URGENCY" };
const URGENCY_CLASSES = {
  blocking: "text-danger-foreground",
  soon: "text-warning-foreground",
  fyi: "text-foreground-muted",
  none: "text-foreground-muted",
};

function AskRow({ row }: { readonly row: ArchiveWarningRow }) {
  const urgency = row.urgency ?? "none";
  return (
    <View className="gap-1 rounded-xl bg-grouped-card px-4 py-3">
      <View className="flex-row flex-wrap items-center">
        <AppText textRole="caption" className={`mr-2 font-t3-bold ${URGENCY_CLASSES[urgency]}`}>
          {URGENCY_LABELS[urgency]}
        </AppText>
        <AppText textRole="label" className="mr-2 min-w-0 shrink text-foreground-muted">
          {row.direction === "inbound" ? "From" : "To"}{" "}
          <AppText textRole="label" className="font-t3-medium text-foreground">
            {row.participant.displayName}
          </AppText>
        </AppText>
        <AppText textRole="label" className="ml-auto tabular-nums text-foreground-tertiary">
          open {relativeTime(row.openedAt)}
        </AppText>
      </View>
      <AppText textRole="footnote" className="text-foreground" selectable>
        {row.intent}
      </AppText>
    </View>
  );
}

function ArchiveWarningFacts({ payload }: { readonly payload: ArchiveWarningPayload }) {
  const crews = payload.crews?.state === "known" ? payload.crews.crews : [];
  const asks = asksByUrgency(payload.openAsks);
  const placed =
    payload.placement.state === "known"
      ? payload.placement.participants.map((participant) => participant.displayName)
      : [];
  return (
    <View className="gap-4">
      {payload.factsUnavailable ? (
        <AppText textRole="body" className="text-foreground">
          Couldn't check open asks or the placement subtree.
        </AppText>
      ) : null}
      {payload.placement.state === "unknown" && !payload.factsUnavailable ? (
        <AppText textRole="body" className="text-foreground">
          Placement subtree: couldn't check.
        </AppText>
      ) : null}
      {payload.crews?.state === "unknown" && !payload.factsUnavailable ? (
        <AppText textRole="body" className="text-foreground">
          Crews it commands: couldn't check.
        </AppText>
      ) : null}
      {crews.length > 0 ? (
        <View className="gap-2">
          <AppText textRole="body" className="font-t3-medium text-foreground">
            A Captain is never archived alone. {crews.length === 1 ? "This Crew" : "These Crews"}{" "}
            {crews.length === 1 ? "retires" : "retire"} with it, every seat together:
          </AppText>
          {crews.map((crew) => (
            <View key={crew.crewInstanceId} className="gap-1 rounded-xl bg-grouped-card px-4 py-3">
              <AppText textRole="footnote" className="font-t3-medium text-foreground">
                Crew · {crew.crewName} ({crew.seats.length}{" "}
                {crew.seats.length === 1 ? "seat" : "seats"})
              </AppText>
              {crew.seats.map((seat) => {
                const consequences = archiveWarningSeatConsequences(seat);
                return (
                  <View key={seat.seat} className="flex-row items-baseline gap-2">
                    <AppText textRole="caption" className="uppercase text-foreground-muted">
                      {seat.seat}
                    </AppText>
                    <AppText textRole="footnote" className="min-w-0 shrink text-foreground">
                      {seat.participant.displayName}
                    </AppText>
                    {consequences === "" ? null : (
                      <AppText textRole="label" className="ml-auto text-foreground-muted">
                        {consequences}
                      </AppText>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}
      {placed.length > 0 ? (
        <AppText textRole="body" className="text-foreground">
          {placed.length} agent{placed.length === 1 ? "" : "s"} placed under {payload.threadTitle}{" "}
          keep{placed.length === 1 ? "s" : ""} running: {placed.join(", ")}
          {sentenceEnd(placed.at(-1) ?? "")}
        </AppText>
      ) : null}
      {asks.length > 0 ? (
        <View className="gap-2">
          <AppText textRole="body" className="font-t3-medium text-foreground">
            {archiveWarningAskHeader(asks.length)}
          </AppText>
          {asks.map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- a fixed list read once for the sheet; entries have no id and may repeat.
            <AskRow key={`${row.direction}-${row.openedAt}-${index}`} row={row} />
          ))}
        </View>
      ) : null}
      <AppText textRole="footnote" className="text-foreground-muted">
        {ARCHIVE_WARNING_WORKSPACE_NOTE}
      </AppText>
    </View>
  );
}

/** J5's archive warning (register D13): every fact, scrollable, with one destructive confirm. */
export function ArchiveWarningHost() {
  const current = useSyncExternalStore(subscribe, getPresented, getPresented);
  if (current === null) return null;
  const { warning } = current;
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={() => answer(false)}
    >
      {/* A Modal is its own native hierarchy, so it measures its own safe area. The theme's
          surface goes on a View, as upstream's sheets do: SafeAreaView doesn't take className. */}
      <SafeAreaProvider style={{ flex: 1 }}>
        <View className="flex-1 bg-sheet">
          <SafeAreaView style={{ flex: 1 }}>
            <AppText textRole="title" className="px-5 pb-2 pt-5 font-t3-bold text-foreground">
              {warning.title}
            </AppText>
            <ScrollView className="flex-1" contentContainerClassName="px-5 pb-6 pt-2">
              {warning.payload === null ? null : <ArchiveWarningFacts payload={warning.payload} />}
            </ScrollView>
            <View className="flex-row gap-3 border-t border-separator px-5 pb-2 pt-3">
              <View className="flex-1">
                <Button label="Cancel" fullWidth onPress={() => answer(false)} />
              </View>
              <View className="flex-1">
                <Button
                  label={warning.confirmLabel}
                  tone="danger"
                  fullWidth
                  onPress={() => answer(true)}
                />
              </View>
            </View>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}
