import { useAtomValue } from "@effect/atom-react";
import {
  answeredByLine,
  closedLine,
  j5SourceNotice,
  mergeHumanInboxSources,
  type PresentedHumanInboxItem,
} from "@t3tools/client-runtime/j5/inbox";
import { presentParticipantIdentity } from "@t3tools/client-runtime/j5/participant-identity";
import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopedInboxItemKey } from "@t3tools/contracts/j5";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { type ClosedItem, useInboxAnswers } from "./inboxAnswers";
import {
  answeredInboxQueryAtom,
  answeredInboxSourcesAtom,
  openInboxQueryAtom,
  openInboxSourcesAtom,
  readInboxSources,
  refreshInboxSources,
} from "./inboxSources";
import { createPullRefresh } from "./inboxPullRefresh.logic";
import { useScopedParticipantLabels } from "./senderLabels";

type SenderLabels = ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>;

const NO_LABELS: ReadonlyMap<string, string> = new Map();

const URGENCY = {
  blocking: { label: "Blocking", className: "text-danger-foreground" },
  soon: { label: "Soon", className: "text-warning-foreground" },
  fyi: { label: "FYI", className: "text-foreground-muted" },
} as const;

const senderName = (item: PresentedHumanInboxItem, labels: SenderLabels) =>
  presentParticipantIdentity({
    participantId: item.senderId,
    participantLabels: labels.get(item.environmentId) ?? NO_LABELS,
  }).label;

/** The reader's own name on an item's server, so "Priya answered" can read "You answered". */
function useOwnName(environmentId: EnvironmentId): string | null {
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  return access?.kind === "person" ? access.name : null;
}

function refreshAll() {
  refreshInboxSources(openInboxSourcesAtom, openInboxQueryAtom);
  refreshInboxSources(answeredInboxSourcesAtom, answeredInboxQueryAtom);
}

/**
 * The person's Inbox: what agents on every connected server have asked them, most urgent first
 * (Inbox AC6), answered in place, and the asks already answered.
 */
export function InboxScreen() {
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const items = mergeHumanInboxSources(openSources);
  const answered = mergeHumanInboxSources(answeredSources);
  const showEnvironment = spansMultipleEnvironments([...items, ...answered]);
  const labels = useScopedParticipantLabels(
    [...items, ...answered].map((item) => ({
      environmentId: item.environmentId,
      participantId: item.senderId,
      connected: item.connected,
    })),
  );
  const answers = useInboxAnswers({ openSources, items, answeredSources, answered });
  // Reads again each time the Inbox comes into view; between visits the server's inbox signal
  // rereads it. No timer.
  useFocusEffect(useCallback(() => refreshAll(), []));
  const loading =
    !openSources.isReady || openSources.sources.some((source) => source.status === "loading");
  // The spinner is for a refresh the person asked for: an answer's re-read updates the list quietly.
  const [refreshing, setRefreshing] = useState(false);
  const [pullToRefresh] = useState(() =>
    createPullRefresh({ read: readInboxSources, onChange: setRefreshing }),
  );
  const notices = [
    ...new Set(
      [...openSources.sources, ...answeredSources.sources].flatMap((source) => {
        const notice = j5SourceNotice(source);
        return notice === null ? [] : [notice];
      }),
    ),
  ];
  const content = (
    <>
      <NativeStackScreenOptions options={{ title: "Inbox" }} />
      {notices.map((notice) => (
        <Text key={notice} className="text-sm text-foreground-muted">
          {notice}
        </Text>
      ))}
      {answers.shownItems.length === 0 ? (
        loading ? (
          <Text className="text-foreground-muted">Loading your inbox…</Text>
        ) : (
          <EmptyState
            variant="plain"
            title="Nothing waiting on you"
            detail="When an agent asks you something, it shows up here."
          />
        )
      ) : (
        <View className="gap-3">
          {answers.shownItems.map((item) => {
            const key = scopedInboxItemKey(item);
            return (
              <InboxItem
                key={key}
                item={item}
                labels={labels}
                showEnvironment={showEnvironment}
                closed={answers.closedOf(item)}
                answerText={answers.answerText(item)}
                onChangeAnswer={(text) => answers.setAnswerText(item, text)}
                onAnswer={() => void answers.answer(item)}
                delivering={answers.pendingKey === key}
                error={answers.errorFor(item)}
                anyDelivering={answers.pendingKey !== null}
              />
            );
          })}
        </View>
      )}
      <AnsweredShelf items={answered} labels={labels} showEnvironment={showEnvironment} />
    </>
  );
  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={() => void pullToRefresh()} />
  );
  // iOS keeps upstream's scroll view, which registers with the native header, and lets it move the
  // focused answer box above the keyboard, as upstream's commit sheet does. Android has no header
  // marker, so keyboard-controller's scroll view brings the box being typed in clear of the keyboard.
  return Platform.OS === "ios" ? (
    <ScreenScrollView
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-4 py-4"
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      {content}
    </ScreenScrollView>
  ) : (
    <KeyboardAwareScrollView
      bottomOffset={80}
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-4 py-4"
      // Android's content width cap, as upstream's ScreenScrollView applies it.
      contentContainerStyle={{ width: "100%", maxWidth: 720, alignSelf: "center" }}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      {content}
    </KeyboardAwareScrollView>
  );
}

function ItemMeta(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
  readonly trailing?: string | null;
}) {
  const { item } = props;
  const parts = [
    senderName(item, props.labels),
    item.projectTitle,
    item.forEveryone === true ? "for everyone here" : null,
    props.showEnvironment || !item.connected
      ? `${props.showEnvironment ? item.environmentLabel : ""}${item.connected ? "" : props.showEnvironment ? " (offline)" : "offline"}`
      : null,
    props.trailing ?? null,
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={2}>
      {parts.join(" · ")}
    </Text>
  );
}

function InboxItem(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
  /** The item closed while the person had typed into it, and stays with their words (AC17). */
  readonly closed: ClosedItem | undefined;
  readonly answerText: string;
  readonly onChangeAnswer: (text: string) => void;
  readonly onAnswer: () => void;
  readonly delivering: boolean;
  readonly anyDelivering: boolean;
  /** Why this ask's last answer was not delivered, or a stale list after it was. */
  readonly error: string | null;
}) {
  const { item } = props;
  const [expanded, setExpanded] = useState(false);
  const urgency = URGENCY[item.urgency];
  const ownName = useOwnName(item.environmentId);
  const mayAnswer = useAtomValue(
    j5Environment.answerHumanExchange.permissionAtom(item.environmentId),
  );
  const canAnswer = item.sourceReady && mayAnswer;
  const closedText = props.closed === undefined ? null : closedLine({ ...props.closed, ownName });
  return (
    <View className="rounded-2xl border-continuous bg-card px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${urgency.label}. ${item.intent}`}
        onPress={() => setExpanded(!expanded)}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          <Text className={`text-xs font-t3-semibold uppercase ${urgency.className}`}>
            {urgency.label}
          </Text>
          <View className="flex-1" />
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </View>
        <Text className="text-base font-t3-semibold">{item.intent}</Text>
        <ItemMeta
          item={item}
          labels={props.labels}
          showEnvironment={props.showEnvironment}
          trailing={props.closed === undefined ? `open ${relativeTime(item.openedAt)}` : null}
        />
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 border-t border-border-subtle pt-3">
          <InboxMessage markdown={item.message} />
          {/* Above the answer box, so it stays in view whenever the box is: iOS scrolls only the
              focused box itself clear of the keyboard. */}
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <OpenSenderThread item={item} />
            {closedText !== null ? (
              <Text className="text-sm text-foreground-muted">{closedText}</Text>
            ) : (
              <Button
                label={props.delivering ? "Delivering…" : "Answer"}
                tone="primary"
                loading={props.delivering}
                disabled={!canAnswer || props.anyDelivering || props.answerText.length === 0}
                accessibilityHint={
                  canAnswer
                    ? undefined
                    : "This server is unavailable or this connection is read-only."
                }
                onPress={props.onAnswer}
              />
            )}
          </View>
          <TextInput
            accessibilityLabel={`Answer ${item.intent}`}
            multiline
            placeholder="Type the answer exactly as it should be delivered"
            value={props.answerText}
            onChangeText={props.onChangeAnswer}
            style={{ minHeight: 96, textAlignVertical: "top" }}
          />
          {props.error === null ? null : (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {props.error}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function InboxMessage(props: { readonly markdown: string }) {
  const styles = useMarkdownPreviewStyles();
  return <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />;
}

function OpenSenderThread(props: { readonly item: PresentedHumanInboxItem }) {
  const openLinkedThread = useOpenLinkedThread();
  const { item } = props;
  const available = item.connected && item.senderThreadId !== null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ disabled: !available }}
      disabled={!available}
      hitSlop={6}
      onPress={() =>
        item.senderThreadId !== null &&
        openLinkedThread({
          environmentId: String(item.environmentId),
          threadId: item.senderThreadId,
        })
      }
    >
      <Text
        className={`font-t3-medium text-sm ${available ? "text-foreground-secondary" : "text-foreground-muted"}`}
      >
        {available
          ? "Open thread"
          : item.senderThreadId === null
            ? "The sender is no longer in the roster"
            : "Its server is offline"}
      </Text>
    </Pressable>
  );
}

function AnsweredShelf(props: {
  readonly items: ReadonlyArray<PresentedHumanInboxItem>;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (props.items.length === 0) return null;
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="flex-row items-center gap-2 py-2"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="font-t3-medium text-foreground-muted">Answered {props.items.length}</Text>
      </Pressable>
      {open
        ? props.items.map((item) => (
            <AnsweredItem
              key={scopedInboxItemKey(item)}
              item={item}
              labels={props.labels}
              showEnvironment={props.showEnvironment}
            />
          ))
        : null}
    </View>
  );
}

function AnsweredItem(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
}) {
  const { item } = props;
  const answeredBy = answeredByLine(item.answeredBy, useOwnName(item.environmentId));
  const when = item.terminalAt ? `answered ${relativeTime(item.terminalAt)}` : "answered";
  return (
    <View className="gap-1 rounded-2xl bg-card px-4 py-3">
      <Text className="text-sm font-t3-medium">{item.intent}</Text>
      <ItemMeta
        item={item}
        labels={props.labels}
        showEnvironment={props.showEnvironment}
        trailing={answeredBy === null ? when : `${when} · ${answeredBy}`}
      />
      <OpenSenderThread item={item} />
    </View>
  );
}
