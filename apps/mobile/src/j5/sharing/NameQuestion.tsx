import { useAtomValue } from "@effect/atom-react";
import {
  NAME_NOT_USABLE,
  levelLabel,
  nameIsInUse,
  offeredLevel,
} from "@t3tools/client-runtime/j5/sharing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { isPersonName } from "@t3tools/contracts/j5";
import { useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { j5Sharing } from "./guestAccess";
import { identityCommands, nameToAskAtom, putOffNameQuestionsAtom } from "./identity";

const SOMEONE_NEW = "new";

/**
 * Asks the name question of the first saved server that needs it. Mounted once, at the root, so
 * it covers every screen until it is answered.
 */
export function NameQuestionHost() {
  const asking = useAtomValue(nameToAskAtom);
  if (asking === null) return null;
  return <NameQuestion key={asking.id} environmentId={asking.id} kind={asking.kind} />;
}

/**
 * "What should people and agents on <server> call you?", asked before a device uses the server
 * (People and access AC5, AC6), as web's `NameDialog` asks it. A device the server cannot place may
 * put it off with "Not now" until the app next starts, and anyone may forget the server with
 * "Remove this server"; both touch only this server.
 */
function NameQuestion({
  environmentId,
  kind,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: "claim" | "first-owner";
}) {
  const presentation = useAtomValue(environmentPresentations.presentationsAtom).get(environmentId);
  const serverName = presentation?.entry.target.label ?? "this server";
  const claimable = useEnvironmentQuery(
    kind === "claim" ? identityCommands.claimablePeople({ environmentId, input: {} }) : null,
  );
  const claimDevice = useAtomCommand(identityCommands.claimDevice, { reportFailure: false });
  const setFirstOwnerName = useAtomCommand(identityCommands.setFirstOwnerName, {
    reportFailure: false,
  });
  const removeServer = useAtomCommand(environmentCatalog.remove, "environment remove");
  const people = kind === "claim" ? (claimable.data?.people ?? []) : [];
  const [choice, setChoice] = useState<string>(SOMEONE_NEW);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const naming = kind === "first-owner" || choice === SOMEONE_NEW;

  const save = async () => {
    const typed = name.trim();
    if (naming && !isPersonName(typed)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    const result =
      kind === "first-owner"
        ? await setFirstOwnerName({ environmentId, input: { name: typed } })
        : await claimDevice({
            environmentId,
            input:
              choice === SOMEONE_NEW
                ? { kind: "new", name: typed }
                : { kind: "person", personId: choice },
          });
    if (result._tag === "Failure") {
      setBusy(false);
      const cause = squashAtomCommandFailure(result);
      setError(
        nameIsInUse(cause)
          ? `Someone on ${serverName} already has that name.`
          : cause instanceof Error && cause.message.trim() !== ""
            ? cause.message
            : "The server did not say why.",
      );
      return;
    }
    // A claimed device's session is ended for renewal, which reconnects it and reads its access
    // again, closing this; it stays "Saving…" until then, and the people list's failed re-read
    // during the renewal is not shown. The first owner's access is read again here.
    j5Sharing.refreshConnectionAccess(appAtomRegistry, environmentId);
  };

  const putOff = () =>
    appAtomRegistry.update(putOffNameQuestionsAtom, (ids) => new Set([...ids, environmentId]));

  const confirmRemove = () =>
    Dialog.alert(
      "Remove from this device?",
      `Forget ${serverName} and its cached threads on this device. Your other servers stay as they are.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void removeServer(environmentId),
        },
      ],
    );

  const nameInput = (label: string) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      autoFocus={kind === "first-owner" || people.length === 0}
      autoCapitalize="words"
      autoCorrect={false}
      maxLength={80}
      value={name}
      editable={!busy}
      returnKeyType="done"
      onSubmitEditing={() => void save()}
      onChangeText={(value) => {
        setName(value);
        setChoice(SOMEONE_NEW);
        setError(null);
      }}
    />
  );

  return (
    // Full screen, so it can't be swiped away; "Not now" and "Remove this server" are the ways out.
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => {}}>
      {/* SafeAreaView takes no className, so the theme surface and flex go on a View. */}
      <View className="flex-1 bg-screen">
        <SafeAreaView style={{ flex: 1 }}>
          <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 p-5">
              <View className="gap-2">
                <Text accessibilityRole="header" className="text-2xl font-t3-semibold">
                  What should people and agents on {serverName} call you?
                </Text>
                {kind === "claim" ? (
                  <Text className="text-foreground-muted">
                    This device is paired but the server does not know who it belongs to.
                  </Text>
                ) : null}
              </View>
              {people.length > 0 ? (
                <ListSection>
                  {people.map((person, index) => {
                    const level = offeredLevel(person.levels);
                    return (
                      <ListChoiceRow
                        key={person.personId}
                        label={person.name}
                        description={level === null ? undefined : levelLabel(level)}
                        selected={choice === person.personId}
                        separated={index > 0}
                        disabled={busy}
                        onPress={() => {
                          setChoice(person.personId);
                          setError(null);
                        }}
                      />
                    );
                  })}
                  <ListChoiceRow
                    label="Someone new"
                    selected={choice === SOMEONE_NEW}
                    separated
                    disabled={busy}
                    onPress={() => {
                      setChoice(SOMEONE_NEW);
                      setError(null);
                    }}
                  />
                </ListSection>
              ) : null}
              {naming ? nameInput(people.length > 0 ? "Someone new" : "Your name") : null}
              {claimable.error === null || busy ? null : (
                <Text className="text-sm text-foreground-muted">
                  The people on this server could not be listed: {claimable.error}
                </Text>
              )}
              {error === null ? null : (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {error}
                </Text>
              )}
              <Button
                label={busy ? "Saving…" : "Continue"}
                tone="primary"
                fullWidth
                loading={busy}
                disabled={naming && name.trim() === ""}
                onPress={() => void save()}
              />
              {/* Ways out that touch only this server. A device the server cannot place reaches nothing
                there until it says whose it is, so it may put the question off; the first owner
                already holds the server, so only naming or removing it ends their question (AC6). */}
              {kind === "claim" ? (
                <Button
                  label="Not now"
                  tone="secondary"
                  fullWidth
                  disabled={busy}
                  accessibilityHint={`Asks again the next time the app opens. Until then, ${serverName} shows nothing.`}
                  onPress={putOff}
                />
              ) : null}
              <Button
                label="Remove this server"
                tone="text"
                fullWidth
                disabled={busy}
                onPress={confirmRemove}
              />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
