import { assert, it } from "@effect/vitest";

import { shouldShowOpenInboxCount } from "./HumanInboxBell";

it("shows only positive known open counts", () => {
  assert.equal(shouldShowOpenInboxCount(null), false);
  assert.equal(shouldShowOpenInboxCount(0), false);
  assert.equal(shouldShowOpenInboxCount(3), true);
});
