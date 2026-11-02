import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  playbookWorkspaces,
} from "@t3tools/client-runtime/j5/playbooks";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { useServerConfigs } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { threadEnvironment } from "../../state/threads";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import {
  SettingsFormScreen,
  useSettingsFormExit,
  useSettingsFormParams,
} from "../agents/SettingsFormScreen";
import { preparePlaybookDraft } from "./preparePlaybookDraft";

/** Projects place conversations; the playbook itself belongs to the environment. */
export function PlaybookConversationScreen() {
  const { environmentId, name, projectId } =
    useSettingsFormParams<"SettingsPlaybookConversation">();
  const navigation = useNavigation();
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const workspaces = playbookWorkspaces(
    projects.filter((project) => project.environmentId === environmentId),
    [],
  );
  const [selected, setSelected] = useState(
    (workspaces.find((entry) => entry.projectId === projectId) ?? workspaces[0])?.key ?? "",
  );
  const workspace = workspaces.find((entry) => entry.key === selected) ?? workspaces[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exit = useSettingsFormExit({ hasChanges: false, saving: busy });
  const serverConfigs = useServerConfigs();
  const readCatalog = useAtomQueryRunner(agentPersonaEnvironment.catalog, {
    reportFailure: false,
    refresh: true,
  });
  const readAuthor = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  const editAuthor = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const createPersona = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const launch = useRef<{ key: string; target: Parameters<typeof startTurn>[0] } | null>(null);
  async function submit() {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    const opened = await settlePromise(async () => {
      if (name !== null) {
        const draftId = preparePlaybookDraft(workspace, `Start playbook ${name}`);
        exit.allowLeaving();
        navigation.dispatch(
          StackActions.replace("Thread", {
            draft: {
              environmentId,
              projectId: workspace.projectId,
              title: workspace.title,
              draftId,
            },
          }),
        );
      } else {
        if (launch.current?.key !== workspace.key) {
          const modelSelection = await ensurePlaybookAuthor({
            providers: serverConfigs.get(environmentId)?.providers ?? [],
            readCatalog: async () => {
              const result = await readCatalog({ environmentId, input: {} });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return result.value;
            },
            readDefinition: async (personaId) => {
              const result = await readAuthor({ environmentId, input: { personaId } });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return result.value.definition;
            },
            editPersona: async (input) => {
              const result = await editAuthor({ environmentId, input });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
            createPersona: async (input) => {
              const result = await createPersona({ environmentId, input });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
          });
          const metadata = makeTurnCommandMetadata();
          launch.current = {
            key: workspace.key,
            target: playbookAuthorLaunch({
              workspace,
              modelSelection,
              commandId: CommandId.make(metadata.commandId),
              threadId: ThreadId.make(metadata.threadId),
              messageId: MessageId.make(metadata.messageId),
              createdAt: metadata.createdAt,
            }),
          };
        }
        const { target } = launch.current;
        const result = await startTurn(target);
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        exit.allowLeaving();
        navigation.dispatch(
          StackActions.replace("Thread", { environmentId, threadId: target.input.threadId }),
        );
      }
    });
    setBusy(false);
    if (opened._tag === "Failure") {
      const cause = squashAtomCommandFailure(opened);
      setError(cause instanceof Error ? cause.message : "Could not open the conversation.");
    }
  }
  return (
    <SettingsFormScreen
      title={name === null ? "Create playbook" : "Prepare chat"}
      guarded={exit.guarded}
    >
      <Text className="text-foreground-muted">
        {name === null
          ? "Choose a project for the conversation. New playbooks are saved to the environment library."
          : "Choose the project to run the playbook in."}
      </Text>
      {workspace ? (
        <View pointerEvents={busy ? "none" : "auto"}>
          <Menu
            actions={workspaces.map((entry) => ({
              id: entry.key,
              title: entry.title,
              state: entry.key === workspace.key ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) => setSelected(nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              className="rounded-lg border border-border p-3"
            >
              <Text>{workspace.title}</Text>
            </Pressable>
          </Menu>
        </View>
      ) : (
        <Text>Add a project to open a conversation. You can import playbooks without one.</Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !workspace }}
        disabled={busy || !workspace}
        className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40"
        onPress={() => void submit()}
      >
        <Text className="font-t3-semibold text-primary-foreground">
          {name === null ? "Open Playbook Author" : "Prepare chat"}
        </Text>
      </Pressable>
    </SettingsFormScreen>
  );
}
