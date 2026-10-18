import { describe, expect, it } from "vite-plus/test";

import {
  HIGHLIGHTS,
  highlightsForClient,
  unseenHighlights,
  withHighlightSeen,
  type Highlight,
} from "./highlights.ts";

const entry = (id: string, clients: Highlight["clients"] = ["web", "desktop"]): Highlight => ({
  id,
  title: id,
  description: id,
  clients,
});

const entries = [entry("c"), entry("b"), entry("a")];

describe("unseenHighlights", () => {
  it("shows nothing while first run is unfinished", () => {
    expect(unseenHighlights({ entries, seen: null, firstRunComplete: false })).toEqual([]);
    expect(unseenHighlights({ entries, seen: [], firstRunComplete: false })).toEqual([]);
  });

  it("shows every entry to a finished client with no record", () => {
    expect(unseenHighlights({ entries, seen: null, firstRunComplete: true })).toEqual(entries);
  });

  it("shows only entries missing from the record, newest first", () => {
    expect(
      unseenHighlights({ entries, seen: ["b"], firstRunComplete: true }).map((e) => e.id),
    ).toEqual(["c", "a"]);
  });

  it("shows nothing to a new client whose first run recorded every entry", () => {
    const seen = entries.map((e) => e.id);
    expect(unseenHighlights({ entries, seen, firstRunComplete: true })).toEqual([]);
  });

  it("shows an entry added after first run", () => {
    const seen = entries.map((e) => e.id);
    const next = [entry("d"), ...entries];
    expect(
      unseenHighlights({ entries: next, seen, firstRunComplete: true }).map((e) => e.id),
    ).toEqual(["d"]);
  });
});

describe("withHighlightSeen", () => {
  it("dismissing from no record keeps the others unseen", () => {
    const seen = withHighlightSeen(null, "b");
    expect(unseenHighlights({ entries, seen, firstRunComplete: true }).map((e) => e.id)).toEqual([
      "c",
      "a",
    ]);
  });

  it("does not repeat an id", () => {
    expect(withHighlightSeen(["a"], "a")).toEqual(["a"]);
  });
});

describe("highlightsForClient", () => {
  it("keeps entries meant for the client", () => {
    const mixed = [entry("w", ["web"]), entry("m", ["mobile"]), entry("d", ["desktop", "web"])];
    expect(highlightsForClient(mixed, "desktop").map((e) => e.id)).toEqual(["d"]);
    expect(highlightsForClient(mixed, "mobile").map((e) => e.id)).toEqual(["m"]);
  });
});

describe("HIGHLIGHTS", () => {
  it("has unique ids", () => {
    const ids = HIGHLIGHTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
