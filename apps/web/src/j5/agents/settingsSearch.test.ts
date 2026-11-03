import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "../../components/settings/settingsSearch";

describe("persona library settings search", () => {
  it("finds Agent Setup by its sections and old name", () => {
    expect(searchSettings("personas")[0]).toMatchObject({
      id: "personas",
      to: "/settings/personas",
    });
    for (const query of ["Agent Setup", "personas", "crews", "playbooks", "agents"]) {
      expect(searchSettings(query).some((entry) => entry.id === "personas")).toBe(true);
    }
  });
});
