import { isMarkedShareLink } from "@t3tools/contracts/j5";
import { getPairingTokenFromUrl } from "@t3tools/shared/remote";
import { assert, it } from "@effect/vitest";

import { guestShareLink } from "./liveTestOwnerClient.ts";

it("gives a guest the link the Share dialog would: the pairing address, marked as a share link", () => {
  const link = guestShareLink("http://localhost:8514", "SECRET");
  assert.equal(link, "http://localhost:8514/pair#token=SECRET&j5share=1");
  // What the page that opens it reads: the mark, and upstream's token beside it.
  assert.isTrue(isMarkedShareLink(link));
  assert.equal(getPairingTokenFromUrl(new URL(link)), "SECRET");
});
