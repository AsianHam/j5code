import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "../providerInstance.ts";
import type { ServerProvider } from "../server.ts";
import {
  crewMemberModelCounts,
  crewMemberModelRefusal,
  eligibleCrewMemberModels,
  isCrewMemberModelChecked,
} from "./crewMemberModels.ts";

const provider = (
  instanceId: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: models.map((slug) => ({ slug, name: slug.toUpperCase() })),
    ...overrides,
  }) as unknown as ServerProvider;

const codex = ProviderInstanceId.make("codex");
const checked = (...models: ReadonlyArray<string>) =>
  models.map((model) => ({ instanceId: codex, model }));

describe("crew member models", () => {
  const providers = [provider("codex", ["a", "b", "c"]), provider("claude", ["x"])];

  it("makes every model eligible until a list is saved", () => {
    expect(isCrewMemberModelChecked(null, { instanceId: codex, model: "anything" })).toBe(true);
    expect(eligibleCrewMemberModels(null, providers).map(({ model }) => model)).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
    expect(crewMemberModelCounts(null, providers)).toEqual({ checked: 4, total: 4 });
  });

  it("makes only the checked models eligible, so a model new to the catalog starts unchecked", () => {
    const list = checked("a", "b");
    expect(isCrewMemberModelChecked(list, { instanceId: codex, model: "b" })).toBe(true);
    expect(isCrewMemberModelChecked(list, { instanceId: codex, model: "c" })).toBe(false);
    // The same slug on another instance is another model.
    expect(
      isCrewMemberModelChecked(list, { instanceId: ProviderInstanceId.make("claude"), model: "a" }),
    ).toBe(false);
    expect(crewMemberModelCounts(list, providers)).toEqual({ checked: 2, total: 4 });
  });

  it("counts checked models that are in the catalog and keeps stale entries out of the count", () => {
    const list = checked("a", "retired");
    expect(crewMemberModelCounts(list, providers)).toEqual({ checked: 1, total: 4 });
    expect(eligibleCrewMemberModels(list, providers).map(({ model }) => model)).toEqual(["a"]);
  });

  it("offers only models of providers that are set up", () => {
    const signedOut = provider("cursor", ["z"], { status: "error" });
    const disabled = provider("grok", ["y"], { enabled: false });
    const all = [...providers, signedOut, disabled];
    expect(crewMemberModelCounts(null, all)).toEqual({ checked: 4, total: 4 });
  });

  it("treats a saved empty list as nothing eligible", () => {
    expect(eligibleCrewMemberModels([], providers)).toEqual([]);
    expect(crewMemberModelCounts([], providers)).toEqual({ checked: 0, total: 4 });
  });

  it("names the model, the project, the setting and what is eligible", () => {
    const message = crewMemberModelRefusal({
      selection: { instanceId: "codex", model: "c" },
      projectTitle: "Billing Migration",
      eligible: eligibleCrewMemberModels(checked("a"), providers),
    });
    expect(message).toContain("Model c on codex");
    expect(message).toContain('"Billing Migration"');
    expect(message).toContain("Models for custom members in Agent Setup");
    expect(message).toContain("Eligible models: codex/a.");
  });

  it("says when nothing is eligible, and bounds a long list", () => {
    const none = crewMemberModelRefusal({
      selection: { instanceId: "codex", model: "c" },
      projectTitle: "P",
      eligible: [],
    });
    expect(none).toContain("nothing is checked");
    const many = Array.from({ length: 40 }, (_, index) => ({
      instanceId: "codex",
      model: `m${index}`,
    }));
    const long = crewMemberModelRefusal({
      selection: { instanceId: "codex", model: "c" },
      projectTitle: "P",
      eligible: many,
    });
    expect(long).toContain("and 10 more");
    expect(long).not.toContain("m39");
  });
});
