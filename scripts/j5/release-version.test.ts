import { compareSemverVersions } from "@t3tools/shared/semver";
import { describe, expect, it } from "vite-plus/test";

import { nightlyVersion, stableVersionOf } from "./release-version.ts";

describe("J5 date versions", () => {
  it("names a nightly for its UTC build day, without leading zeros", () => {
    expect(nightlyVersion({ date: "20261015", runNumber: 12, tags: [] })).toBe(
      "202610.15.0-nightly.20261015.12",
    );
    expect(nightlyVersion({ date: "20270105", runNumber: 40, tags: [] })).toBe(
      "202701.5.0-nightly.20270105.40",
    );
  });

  it("takes the next number after that day's stable releases, ignoring other days and nightlies", () => {
    const tags = [
      "v202610.14.3",
      "v202610.15.0",
      "v202610.15.1",
      "v202610.15.0-nightly.20261015.12",
      "v202610.15.7-preview.20261015.1",
      "v0.0.48",
      "",
    ];
    expect(nightlyVersion({ date: "20261015", runNumber: 13, tags })).toBe(
      "202610.15.2-nightly.20261015.13",
    );
    expect(nightlyVersion({ date: "20261016", runNumber: 14, tags })).toBe(
      "202610.16.0-nightly.20261016.14",
    );
  });

  it("promotes a nightly to the stable version of its own day and number", () => {
    expect(stableVersionOf("v202610.15.2-nightly.20261015.13")).toBe("202610.15.2");
    expect(() => stableVersionOf("0.0.49-nightly.20261010.3")).toThrow(
      /Expected a nightly version/,
    );
    expect(() => stableVersionOf("202610.15.0")).toThrow(/Expected a nightly version/);
  });

  it("refuses to promote a nightly from before the current stable release", () => {
    const nightly = "v202610.15.0-nightly.20261015.12";
    expect(stableVersionOf(nightly, "v0.0.48")).toBe("202610.15.0");
    expect(stableVersionOf(nightly, "v202610.14.2")).toBe("202610.15.0");
    // The same version again is the release workflow's call: it resumes or refuses by commit.
    expect(stableVersionOf(nightly, "v202610.15.0")).toBe("202610.15.0");
    expect(() => stableVersionOf(nightly, "v202610.15.1")).toThrow(/older than the current stable/);
    expect(() => stableVersionOf(nightly, "v202611.2.0")).toThrow(/older than the current stable/);
  });

  // The order every installer and updater relies on, in the comparison they use.
  it("sorts each release above everything built before it", () => {
    const first = nightlyVersion({ date: "20261015", runNumber: 12, tags: [] });
    const stable = stableVersionOf(first);
    const sameDay = nightlyVersion({ date: "20261015", runNumber: 13, tags: [`v${stable}`] });
    const hotfix = stableVersionOf(sameDay);
    const nextDay = nightlyVersion({ date: "20261016", runNumber: 14, tags: [`v${stable}`] });
    const nextYear = nightlyVersion({ date: "20270101", runNumber: 90, tags: [] });
    const ascending = [
      "0.0.48",
      "0.0.49-nightly.20261010.3",
      first,
      stable,
      sameDay,
      hotfix,
      nextDay,
      nextYear,
    ];
    expect(ascending.toSorted(compareSemverVersions)).toEqual(ascending);
    expect(new Set(ascending).size).toBe(ascending.length);
  });
});
