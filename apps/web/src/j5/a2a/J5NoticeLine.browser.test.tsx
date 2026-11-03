import { MessageId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ChatMessage } from "~/types";

import { render } from "../../../test/render";
import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { renderThreadA2ADelivery } from "./ThreadA2ARenderer";

const CREATED_AT = "2026-10-31T12:00:00.000Z";
const notice = (id: string, text: string, input: Partial<ChatMessage> = {}): ChatMessage => ({
  id: MessageId.make(id),
  role: "user",
  text,
  runId: null,
  streaming: false,
  createdBy: "system",
  creationSource: "server",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...input,
});

const notDelivered = notice(
  "message:j5:a2a:delivery:one",
  [
    "[Cross-agent messaging system notice: message not delivered]",
    "Your message m1 to agent:peer was not delivered: delivery failed 3 times",
    "This is a platform-authored notice, not a peer reply.",
  ].join("\n\n"),
);

const rowContext = (findActive = false) =>
  ({
    findActive,
    participantLabels: new Map([["agent:peer", "Builder"]]),
    skills: [],
    threadRef: null,
    markdownCwd: undefined,
  }) as never;

it("folds a notice to one named line and opens to its detail", async () => {
  await using screen = await render(
    <TimelineRowCtx value={rowContext()}>
      {renderThreadA2ADelivery({ message: notDelivered, timestampLabel: "8:00 AM" })}
    </TimelineRowCtx>,
  );
  const line = screen.getByRole("button", { name: /Message to Builder not delivered/ });
  await expect.element(line).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("8:00 AM")).toBeVisible();
  expect(screen.container.textContent).not.toContain("agent:peer");
  expect(screen.container.textContent).not.toContain("Cross-agent");
  expect(screen.container.textContent).not.toContain("delivery failed");

  await userEvent.click(line);
  await expect.element(screen.getByText(/Delivery failed 3 times/)).toBeVisible();
});

it("opens a folded notice when find matches its detail", async () => {
  await using screen = await render(
    <TimelineRowCtx value={rowContext(true)}>
      {renderThreadA2ADelivery({ message: notDelivered })}
    </TimelineRowCtx>,
  );
  const line = screen.getByRole("button", { name: /Message to Builder not delivered/ });
  const detail = screen.container.querySelector<HTMLElement>("[data-j5-notice-detail]")!;
  expect(detail.hidden).toBe(true);
  expect(detail.querySelector("[data-thread-find-text]")?.textContent).toContain("Delivery failed");

  detail.dispatchEvent(new Event("beforematch"));
  await expect.element(line).toHaveAttribute("aria-expanded", "true");
});

it("draws a seat in trouble with its tone, opening to the error", async () => {
  const report = [
    "<j5_crew_gate>",
    "proposal_id: p1",
    "kind: addition",
    "decision: approved",
    "crew_name: Comedy",
    "seat_failed: punchline | failed | provider_error",
    "seat_pending: prosecutor",
    "roster:",
    "- punchline: participant_id=agent:p persona=advocate thread_id=thread:p start=failed",
    "- prosecutor: participant_id=agent:q persona=critic thread_id=thread:q start=pending",
    "</j5_crew_gate>",
  ].join("\n");
  await using screen = await render(
    <TimelineRowCtx value={rowContext()}>
      {renderThreadA2ADelivery({ message: notice("message:crew", report) })}
    </TimelineRowCtx>,
  );
  await expect.element(screen.getByText("punchline couldn't start")).toBeVisible();
  await expect.element(screen.getByText("prosecutor hasn't confirmed it started")).toBeVisible();
  expect(
    [...screen.container.querySelectorAll("[data-j5-notice-tone]")].map((icon) =>
      icon.getAttribute("data-j5-notice-tone"),
    ),
  ).toEqual(["bad", "warn"]);
  await userEvent.click(screen.getByRole("button", { name: /punchline couldn't start/ }));
  await expect.element(screen.getByText("provider_error")).toBeVisible();
});

it("draws a declined roster as one line", async () => {
  const declined =
    "<j5_crew_gate>\nproposal_id: p2\nkind: roster\ndecision: declined\ndecided_by: Priya\ncrew_name: Comedy\nrequested_seats: setup=scout\n</j5_crew_gate>\n\nThe user declined this crew request.";
  await using screen = await render(
    <TimelineRowCtx value={rowContext()}>
      {renderThreadA2ADelivery({ message: notice("message:crew", declined) })}
    </TimelineRowCtx>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Crew Comedy · roster declined by Priya/ }),
  );
  await expect.element(screen.getByText(/Requested: setup \(scout\)/)).toBeVisible();
});
