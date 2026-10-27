import { describe, expect, it } from "vite-plus/test";

import {
  SETTINGS_SEARCH_ITEMS,
  searchSettings,
  settingsForThisPlatform,
} from "../../components/settings/settingsSearch";

describe("upstream's guest links in J5's Settings (decision 12)", () => {
  it("are not offered by settings search or the command palette", () => {
    expect(searchSettings("guest links").map((item) => item.id)).not.toContain("guest-links");
    expect(settingsForThisPlatform(SETTINGS_SEARCH_ITEMS).map((item) => item.id)).not.toContain(
      "guest-links",
    );
  });
});
