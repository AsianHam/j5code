import { describe, expect, it } from "vite-plus/test";

import type { ProviderOptionDescriptor } from "../model.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import type { ServerProvider } from "../server.ts";
import {
  crewMemberLevelCounts,
  crewMemberProviderLevels,
  crewMemberReasoningRefusal,
  crewMemberSelectionLevel,
  eligibleCrewMemberLevels,
  eligibleCrewMemberLevelsForModel,
  isCrewMemberLevelChecked,
} from "./crewMemberReasoning.ts";

const effort = (
  ids: ReadonlyArray<string>,
  input: { readonly id?: string; readonly defaultId?: string } = {},
): ProviderOptionDescriptor => ({
  id: input.id ?? "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    ...(id === input.defaultId ? { isDefault: true } : {}),
  })),
});

const thinking: ProviderOptionDescriptor = { id: "thinking", label: "Thinking", type: "boolean" };

const model = (slug: string, descriptors?: ReadonlyArray<ProviderOptionDescriptor>) => ({
  slug,
  name: slug.toUpperCase(),
  capabilities: descriptors === undefined ? null : { optionDescriptors: [...descriptors] },
});

const provider = (
  instanceId: string,
  models: ReadonlyArray<ReturnType<typeof model>>,
  overrides: Partial<ServerProvider> = {},
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models,
    ...overrides,
  }) as unknown as ServerProvider;

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const checked = (...levels: ReadonlyArray<string>) =>
  levels.map((level) => ({ instanceId: codex, level }));

describe("crew member reasoning levels", () => {
  const providers = [
    provider("codex", [
      model("a", [effort(["low", "high"], { defaultId: "high" })]),
      model("b", [effort(["medium", "high", "xhigh"])]),
      model("plain"),
    ]),
    provider("claude", [model("x", [thinking, effort(["low", "max"], { id: "effort" })])]),
  ];

  it("derives a provider's levels as the union of its models' choices, in order of first appearance", () => {
    expect(crewMemberProviderLevels(providers[0]!).map(({ level }) => level)).toEqual([
      "low",
      "high",
      "medium",
      "xhigh",
    ]);
    expect(crewMemberProviderLevels(providers[0]!)[0]).toEqual({ level: "low", label: "LOW" });
  });

  it("ignores boolean thinking options and options that are not reasoning", () => {
    const onlyBoolean = provider("grok", [model("g", [thinking, effort(["a"], { id: "mode" })])]);
    expect(crewMemberProviderLevels(onlyBoolean)).toEqual([]);
    expect(crewMemberProviderLevels(providers[1]!).map(({ level }) => level)).toEqual([
      "low",
      "max",
    ]);
  });

  it("makes every level eligible until a list is saved", () => {
    expect(isCrewMemberLevelChecked(null, { instanceId: codex, level: "anything" })).toBe(true);
    expect(eligibleCrewMemberLevels(null, providers)).toHaveLength(6);
    expect(crewMemberLevelCounts(null, providers)).toEqual({ checked: 6, total: 6 });
  });

  it("makes only the checked levels eligible, per provider instance, so a new level starts unchecked", () => {
    const list = checked("low", "high");
    expect(isCrewMemberLevelChecked(list, { instanceId: codex, level: "xhigh" })).toBe(false);
    // The same id on another instance is another level.
    expect(isCrewMemberLevelChecked(list, { instanceId: claude, level: "low" })).toBe(false);
    expect(crewMemberLevelCounts(list, providers)).toEqual({ checked: 2, total: 6 });
  });

  it("keeps stale entries out of the count and the eligible list", () => {
    const list = checked("low", "retired");
    expect(crewMemberLevelCounts(list, providers)).toEqual({ checked: 1, total: 6 });
    expect(eligibleCrewMemberLevels(list, providers).map(({ level }) => level)).toEqual(["low"]);
  });

  it("treats a saved empty list as nothing eligible", () => {
    expect(eligibleCrewMemberLevels([], providers)).toEqual([]);
    expect(crewMemberLevelCounts([], providers)).toEqual({ checked: 0, total: 6 });
  });

  it("offers only levels of providers that are set up", () => {
    const all = [
      ...providers,
      provider("cursor", [model("z", [effort(["q"])])], { status: "error" }),
    ];
    expect(crewMemberLevelCounts(null, all)).toEqual({ checked: 6, total: 6 });
  });

  it("lists the eligible levels of one model in its own order", () => {
    expect(
      eligibleCrewMemberLevelsForModel(checked("xhigh", "high"), providers[0]!, "b").map(
        ({ level }) => level,
      ),
    ).toEqual(["high", "xhigh"]);
    expect(eligibleCrewMemberLevelsForModel(null, providers[0]!, "plain")).toEqual([]);
  });

  it("reads a selection's level from its explicit value, else the model's default", () => {
    const a = providers[0]!.models[0]!;
    expect(crewMemberSelectionLevel(a, [{ id: "reasoningEffort", value: "low" }])).toBe("low");
    expect(crewMemberSelectionLevel(a, undefined)).toBe("high");
    expect(crewMemberSelectionLevel(a, [{ id: "other", value: "low" }])).toBe("high");
    // No explicit value and no default: nothing to check.
    expect(crewMemberSelectionLevel(providers[0]!.models[1]!, [])).toBeNull();
    // A model with no reasoning option has no level.
    expect(crewMemberSelectionLevel(providers[0]!.models[2]!, [])).toBeNull();
  });

  it("names the level, the model, the project, the setting and the levels to use instead", () => {
    const message = crewMemberReasoningRefusal({
      selection: { instanceId: "codex", model: "b", level: "xhigh" },
      projectTitle: "Billing Migration",
      eligible: eligibleCrewMemberLevelsForModel(checked("medium"), providers[0]!, "b"),
    });
    expect(message).toContain("Reasoning level xhigh of b on codex");
    expect(message).toContain('"Billing Migration"');
    expect(message).toContain("Models for custom members in Agent Setup");
    expect(message).toContain("Eligible levels for b: medium.");
  });

  it("says when none of the model's levels is eligible", () => {
    const message = crewMemberReasoningRefusal({
      selection: { instanceId: "codex", model: "b", level: "xhigh" },
      projectTitle: "P",
      eligible: [],
    });
    expect(message).toContain("No reasoning level of b is eligible");
  });
});
