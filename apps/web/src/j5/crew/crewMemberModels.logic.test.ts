import {
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2AgentPersonaCatalog,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crewMemberLevelsSummary,
  crewMemberModelLabel,
  crewMemberModelsSummary,
  crewMemberProviderSummary,
  crewReasoningChoicesFor,
  personasOffCrewMemberModels,
  setCrewMemberLevelChecked,
  setCrewMemberModelChecked,
  setCrewMemberProviderChecked,
  setCrewMemberProviderLevelsChecked,
  withEligibleCrewReasoning,
} from "./crewMemberModels.logic";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
) =>
  ({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: models.map((slug) => ({ slug, name: slug })),
    ...overrides,
  }) as unknown as ServerProvider;

const providers = [provider(codex, ["a", "b", "c"]), provider(claude, ["x"])];
const pair = (instanceId: ProviderInstanceId, model: string) => ({ instanceId, model });

describe("crew member models settings logic", () => {
  it("drops the Claude prefix on the Claude provider only", () => {
    const stock = provider(claude, [], { driver: "claudeAgent" } as Partial<ServerProvider>);
    const viaCursor = provider(ProviderInstanceId.make("cursor"), [], {
      driver: "cursor",
    } as Partial<ServerProvider>);
    expect(crewMemberModelLabel(stock, "Claude Opus 5.5")).toBe("Opus 5.5");
    expect(crewMemberModelLabel(stock, "Haiku 5.5")).toBe("Haiku 5.5");
    expect(crewMemberModelLabel(viaCursor, "Claude Opus 5.5")).toBe("Claude Opus 5.5");
  });

  it("starts from the whole catalog when the first box is unchecked", () => {
    const next = setCrewMemberModelChecked(null, providers, pair(codex, "b"), false);
    expect(next).toEqual([pair(codex, "a"), pair(codex, "c"), pair(claude, "x")]);
  });

  it("checks a model once and keeps entries for models the catalog no longer lists", () => {
    const saved = [pair(codex, "retired")];
    const checked = setCrewMemberModelChecked(saved, providers, pair(codex, "a"), true);
    expect(checked).toEqual([pair(codex, "retired"), pair(codex, "a")]);
    expect(setCrewMemberModelChecked(checked, providers, pair(codex, "a"), true)).toEqual(checked);
    expect(setCrewMemberModelChecked(checked, providers, pair(codex, "a"), false)).toEqual(saved);
  });

  it("checks and unchecks a whole provider without touching the others", () => {
    const only = [pair(claude, "x")];
    const all = setCrewMemberProviderChecked(only, providers, providers[0]!, true);
    expect(all).toEqual([pair(claude, "x"), pair(codex, "a"), pair(codex, "b"), pair(codex, "c")]);
    expect(setCrewMemberProviderChecked(all, providers, providers[0]!, false)).toEqual(only);
  });

  it("counts checked models in the catalog and warns when a saved list leaves none", () => {
    expect(crewMemberModelsSummary(null, providers)).toEqual({
      label: "4 of 4",
      nothingEligible: false,
    });
    expect(crewMemberModelsSummary([pair(codex, "a"), pair(codex, "retired")], providers)).toEqual({
      label: "1 of 4",
      nothingEligible: false,
    });
    expect(crewMemberModelsSummary([], providers)).toEqual({
      label: "0 of 4",
      nothingEligible: true,
    });
    // A list holding only stale entries leaves nothing eligible too.
    expect(crewMemberModelsSummary([pair(codex, "retired")], providers).nothingEligible).toBe(true);
    // With no provider set up there is nothing to warn about.
    expect(crewMemberModelsSummary([], []).nothingEligible).toBe(false);
  });

  it("names the personas that run on a model the list leaves out", () => {
    const entry = (displayName: string, model: string, available = true) => ({
      displayName,
      availability: available
        ? {
            status: "available" as const,
            resolvedModelSelection: { instanceId: codex, model },
          }
        : { status: "unavailable" as const, reason: "routes-unavailable" as const },
    });
    const catalog = {
      personas: [entry("Scout", "a"), entry("Critic", "c"), entry("Blocked", "c", false)],
    } as unknown as OrchestrationV2AgentPersonaCatalog;
    expect(personasOffCrewMemberModels(catalog, [pair(codex, "a")])).toEqual(["Critic"]);
    expect(personasOffCrewMemberModels(catalog, null)).toEqual([]);
    expect(personasOffCrewMemberModels(null, [])).toEqual([]);
  });
});

const effort = (id: string, levels: ReadonlyArray<string>, defaultId?: string) => ({
  id,
  label: "Reasoning",
  type: "select" as const,
  options: levels.map((level) => ({
    id: level,
    label: level.toUpperCase(),
    ...(level === defaultId ? { isDefault: true } : {}),
  })),
});
const withLevels = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<{ slug: string; levels: ReadonlyArray<string>; defaultId?: string }>,
) =>
  ({
    ...provider(instanceId, []),
    models: models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      capabilities: {
        optionDescriptors: [effort("reasoningEffort", model.levels, model.defaultId)],
      },
    })),
  }) as unknown as ServerProvider;
const leveled = [
  withLevels(codex, [
    { slug: "a", levels: ["low", "high"], defaultId: "high" },
    { slug: "b", levels: ["medium", "high", "xhigh"] },
  ]),
  provider(claude, ["x"]),
];
const level = (instanceId: ProviderInstanceId, id: string) => ({ instanceId, level: id });

describe("crew member reasoning settings logic", () => {
  it("starts from the whole level catalog when the first chip is unchecked", () => {
    expect(setCrewMemberLevelChecked(null, leveled, level(codex, "high"), false)).toEqual([
      level(codex, "low"),
      level(codex, "medium"),
      level(codex, "xhigh"),
    ]);
  });

  it("checks a level once and keeps entries for levels the catalog no longer lists", () => {
    const saved = [level(codex, "retired")];
    const checked = setCrewMemberLevelChecked(saved, leveled, level(codex, "low"), true);
    expect(checked).toEqual([level(codex, "retired"), level(codex, "low")]);
    expect(setCrewMemberLevelChecked(checked, leveled, level(codex, "low"), true)).toEqual(checked);
    expect(setCrewMemberLevelChecked(checked, leveled, level(codex, "low"), false)).toEqual(saved);
  });

  it("checks and unchecks a whole provider's levels without touching the others", () => {
    const other = [level(claude, "max")];
    const all = setCrewMemberProviderLevelsChecked(other, leveled, leveled[0]!, true);
    expect(all).toEqual([
      level(claude, "max"),
      level(codex, "low"),
      level(codex, "high"),
      level(codex, "medium"),
      level(codex, "xhigh"),
    ]);
    expect(setCrewMemberProviderLevelsChecked(all, leveled, leveled[0]!, false)).toEqual(other);
  });

  it("counts checked levels in the catalog and warns when a saved list leaves none", () => {
    expect(crewMemberLevelsSummary(null, leveled)).toEqual({
      label: "4 of 4",
      nothingEligible: false,
    });
    expect(
      crewMemberLevelsSummary([level(codex, "low"), level(codex, "retired")], leveled),
    ).toEqual({ label: "1 of 4", nothingEligible: false });
    expect(crewMemberLevelsSummary([], leveled).nothingEligible).toBe(true);
    // A provider with no levels has nothing to warn about.
    expect(crewMemberLevelsSummary([], [provider(claude, ["x"])]).nothingEligible).toBe(false);
  });

  it("summarizes a provider's models and levels, and only its models when it has no levels", () => {
    expect(crewMemberProviderSummary(leveled[0]!, [pair(codex, "a")], [level(codex, "low")])).toBe(
      "1 of 2 models · 1 of 4 levels",
    );
    expect(crewMemberProviderSummary(leveled[0]!, null, null)).toBe(
      "2 of 2 models · 4 of 4 levels",
    );
    expect(crewMemberProviderSummary(leveled[1]!, [], [])).toBe("0 of 1 models");
  });

  it("narrows a custom member's reasoning picker to the allowed levels and leaves a persona's whole", () => {
    const descriptor = effort("reasoningEffort", ["medium", "high", "xhigh"]);
    const allowed = [level(codex, "high")];
    expect(crewReasoningChoicesFor(descriptor, leveled[0], allowed).map(({ id }) => id)).toEqual([
      "high",
    ]);
    // A persona's list is passed as null, which allows everything.
    expect(crewReasoningChoicesFor(descriptor, leveled[0], null)).toHaveLength(3);
    expect(crewReasoningChoicesFor(undefined, leveled[0], allowed)).toEqual([]);
    // A thinking switch is not a level, so a list never narrows it.
    expect(
      crewReasoningChoicesFor(
        { id: "thinking", label: "Thinking", type: "boolean" },
        leveled[0],
        [],
      ).map(({ id }) => id),
    ).toEqual(["true", "false"]);
  });

  it("starts a changed model on its first allowed level when its default is not allowed", () => {
    const [codexProvider] = leveled;
    const modelB = codexProvider!.models[1]!;
    const draft = {
      modelSelection: {
        instanceId: codex,
        model: "b",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    };
    // The model's selected level is allowed, so nothing changes.
    expect(withEligibleCrewReasoning(draft, codexProvider!, modelB, [level(codex, "medium")])).toBe(
      draft,
    );
    const changed = withEligibleCrewReasoning(draft, codexProvider!, modelB, [
      level(codex, "xhigh"),
      level(codex, "high"),
    ]);
    // In the model's own order: high comes before xhigh.
    expect(changed.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    // No list saved, or no allowed level at all: the seat is left as it is.
    expect(withEligibleCrewReasoning(draft, codexProvider!, modelB, null)).toBe(draft);
    expect(withEligibleCrewReasoning(draft, codexProvider!, modelB, [])).toBe(draft);
  });

  it("judges a selection with no explicit level by the model's default", () => {
    const modelA = leveled[0]!.models[0]!;
    const draft: { modelSelection: ModelSelection } = {
      modelSelection: { instanceId: codex, model: "a" },
    };
    expect(withEligibleCrewReasoning(draft, leveled[0]!, modelA, [level(codex, "high")])).toBe(
      draft,
    );
    expect(
      withEligibleCrewReasoning(draft, leveled[0]!, modelA, [level(codex, "low")]).modelSelection
        .options,
    ).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });
});
