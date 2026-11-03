import { MessageId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ChatMessage } from "~/types";

import { render } from "../../../test/render";
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

it("shows the introduction folded to its title and opens to the text the model read", async () => {
  await using screen = await render(
    <>
      {renderThreadA2ADelivery({
        message: message(context("<j5_crew_context>\nYou are the reviewer.\n</j5_crew_context>")),
        timestampLabel: "Today, 8:00 AM",
      })}
    </>,
    { router: false },
  );
  const card = screen.container.querySelector<HTMLDetailsElement>(
    "details[data-j5-crew-context='introduction']",
  )!;
  await expect.element(screen.getByText("Introduction")).toBeVisible();
  expect(card.open).toBe(false);

  await userEvent.click(screen.getByText("Introduction"));
  expect(card.open).toBe(true);
  await expect.element(screen.getByText(/You are the reviewer\./)).toBeVisible();
});

it("titles a roster change as its own card", async () => {
  await using screen = await render(
    <>
      {renderThreadA2ADelivery({
        message: message(
          context(
            "<j5_crew_roster_changed>\njoined: security: participant_id=p1 responsibility=audit\n</j5_crew_roster_changed>",
          ),
        ),
      })}
    </>,
    { router: false },
  );
  await expect.element(screen.getByText("Roster changed")).toBeVisible();
  expect(screen.container.querySelector("[data-j5-crew-context='roster-changed']")).not.toBeNull();
});
