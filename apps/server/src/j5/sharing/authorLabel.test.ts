import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { authorLabel } from "./authorLabel.ts";
import { checkedPersonName } from "./personNames.ts";

it.effect("two people never read as one on the author's line", () =>
  Effect.gen(function* () {
    // A name that holds a level in parentheses is refused when it is given or changed.
    const refused = yield* Effect.flip(checkedPersonName("Pat (owner)"));
    assert.strictEqual(refused._tag, "PersonNameError");
    // Any other parentheses stay, and the line carries the name as it is stored.
    const pat = yield* checkedPersonName("Pat");
    const patQa = yield* checkedPersonName("Pat (QA)");
    assert.strictEqual(
      authorLabel({ displayName: pat, level: "collaborator" }),
      "Pat (collaborator)",
    );
    assert.strictEqual(
      authorLabel({ displayName: patQa, level: "collaborator" }),
      "Pat (QA) (collaborator)",
    );
  }),
);
