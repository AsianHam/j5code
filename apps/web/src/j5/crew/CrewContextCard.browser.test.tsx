import { MessageId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ChatMessage } from "~/types";

import { render } from "../../../test/render";
import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { renderThreadA2ADelivery } from "../a2a/ThreadA2ARenderer";

const CREATED_AT = "2026-10-31T12:00:00.000Z";
const message = (text: string): ChatMessage => ({
  id: MessageId.make("message:j5:crew-context:abc"),
  role: "user",
  text,
  runId: null,
  streaming: false,
  createdBy: "system",
  creationSource: "server",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});
const context = (text: string) =>
  `<j5_crew_delivery_context>\n${text}\n</j5_crew_delivery_context>`;
const rowContext = { findActive: false, participantLabels: new Map() } as never;

it("shows the introduction folded to its title and opens to the text the model read", async () => {
  await using screen = await render(
    <TimelineRowCtx value={rowContext}>
      {renderThreadA2ADelivery({
        message: message(context("<j5_crew_context>\nYou are the reviewer.\n</j5_crew_context>")),
        timestampLabel: "Today, 8:00 AM",
      })}
    </TimelineRowCtx>,
    { router: false },
  );
  const line = screen.getByRole("button", { name: /Introduction from J5/ });
  await expect.element(line).toHaveAttribute("aria-expanded", "false");
  expect(screen.container.textContent).not.toContain("You are the reviewer.");

  await userEvent.click(line);
  await expect.element(line).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText(/You are the reviewer\./)).toBeVisible();
});

it("titles a roster change as its own line", async () => {
  await using screen = await render(
    <TimelineRowCtx value={rowContext}>
      {renderThreadA2ADelivery({
        message: message(
          context(
            "<j5_crew_roster_changed>\njoined: security: participant_id=p1 responsibility=audit\n</j5_crew_roster_changed>",
          ),
        ),
      })}
    </TimelineRowCtx>,
    { router: false },
  );
  await expect.element(screen.getByText("Roster changed from J5")).toBeVisible();
  expect(
    screen.container.querySelector("[data-j5-notice='crew-context-roster-changed']"),
  ).not.toBeNull();
});
