import { describe, expect, it } from "vite-plus/test";
import { searchSettings } from "../../components/settings/settingsSearch";

describe("completion sound settings search", () => {
  it.each(["mp3", "custom sound", "work done", "restore sound"])(
    "finds completion sound for %s",
    (query) => {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({ id: "completion-sound", to: "/settings/general" }),
      );
    },
  );
});
