import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const fixture = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  command: vi.fn(async (_command: unknown, _input: unknown) => {}),
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => ({ projection: fixture.projection })) as never,
}));
vi.mock(import("../../j5/a2a/ParticipantIdentitiesClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  useParticipantLabels: (() => new Map([["agent:peer", "Morgan"]])) as never,
}));
// Shared-conversation authorship (case 80) is not under test; a solo thread shows runs as queued.
vi.mock(import("../../j5/sharing/sharedTimeline"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSharedQueuedRuns: ((_environmentId: unknown, _threadId: unknown, queued: unknown) =>
    queued) as never,
}));
vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: unknown, resources: readonly unknown[]) =>
    resources.map(() => "https://assets.test/image")) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: unknown) => (input: unknown) =>
    fixture.command(command, input)) as never,
}));

import { render } from "../../../test/render";
import { threadEnvironment } from "../../state/threads";
import { QueuedRunsControl } from "./QueuedRunsControl";

const environmentId = EnvironmentId.make("remote-queue");
const threadId = ThreadId.make("queue-thread");
const peerMessage =
  "[Cross-agent message from agent:peer in project project-one (One)]\n\nReview this change.\n\nNo reply is required. Use j5_send_message without exchange_id only if a new message is needed.";
const attachment = {
  type: "image",
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const projection = {
  thread: { id: threadId, activeProviderThreadId: "provider-thread" },
  runs: [
    {
      id: "active",
      status: "running",
      activeAttemptId: "attempt",
      providerThreadId: "provider-thread",
      ordinal: 1,
    },
    { id: "queue-1", status: "queued", userMessageId: "message-1", ordinal: 2, queuePosition: 1 },
    { id: "queue-2", status: "queued", userMessageId: "message-2", ordinal: 3, queuePosition: 2 },
  ],
  messages: [
    { id: "message-1", text: peerMessage, attachments: [attachment] },
    { id: "message-2", text: "Second message", attachments: [] },
  ],
  providerThreads: [{ id: "provider-thread", appThreadId: threadId, providerSessionId: "session" }],
  providerSessions: [
    {
      id: "session",
      status: "running",
      capabilities: {
        turns: {
          supportsQueuedMessages: true,
          supportsActiveSteering: false,
          supportsSteeringByInterruptRestart: true,
        },
      },
    },
  ],
  providerTurns: [{ runAttemptId: "attempt", status: "running" }],
} as unknown as OrchestrationV2ThreadProjection;

it("labels a queued peer message by its sender, keeps its attachments for editing, and acts on the thread's environment", async () => {
  fixture.projection = projection;
  const onEditQueuedRun = vi.fn();
  await using screen = await render(
    <QueuedRunsControl
      environmentId={environmentId}
      threadId={threadId}
      optimisticMessages={[
        { id: MessageId.make("message-1"), inputIntent: "queued_turn", text: peerMessage },
      ]}
      editingRunId={null}
      onEditQueuedRun={onEditQueuedRun}
      onCancelEdit={() => {}}
    />,
  );

  await expect.element(screen.getByText("From Morgan: Review this change.")).toBeVisible();
  expect(screen.container.querySelectorAll("li")).toHaveLength(2);
  await expect.element(screen.getByRole("img", { name: "screenshot.png" })).toBeVisible();

  await screen.getByRole("button", { name: "Edit queued message" }).first().click();
  expect(onEditQueuedRun).toHaveBeenCalledWith({
    runId: "queue-1",
    messageId: "message-1",
    text: peerMessage,
    attachments: [attachment],
  });

  (
    screen
      .getByRole("button", { name: /^Reorder queued/ })
      .nth(1)
      .element() as HTMLElement
  ).focus();
  await userEvent.keyboard("{ArrowUp}");
  expect(fixture.command).toHaveBeenLastCalledWith(threadEnvironment.reorderQueuedRun, {
    environmentId,
    input: { threadId, runId: "queue-2", beforeRunId: "queue-1" },
  });

  const steer = screen.getByRole("button", { name: "Steer" }).first();
  await expect.element(steer).toBeEnabled();
  await steer.click();
  expect(fixture.command).toHaveBeenLastCalledWith(threadEnvironment.promoteQueuedRun, {
    environmentId,
    input: { threadId, queuedRunId: "queue-1", targetRunId: "active" },
  });
});
