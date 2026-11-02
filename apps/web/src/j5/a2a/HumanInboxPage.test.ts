import { assert, it } from "@effect/vitest";

import { captureHumanInboxAnswer } from "./HumanInboxPage";

it("captures typed answer text before the state updater runs", () => {
  const event: { currentTarget: { value: string } | null } = {
    currentTarget: { value: "Verbatim answer" },
  };
  let update:
    | ((current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>)
    | undefined;

  captureHumanInboxAnswer(
    event as { readonly currentTarget: { readonly value: string } },
    "exchange:deferred-update",
    (next) => {
      update = next;
    },
  );
  event.currentTarget = null;

  assert.deepStrictEqual(update?.({ existing: "Kept" }), {
    existing: "Kept",
    "exchange:deferred-update": "Verbatim answer",
  });
});
