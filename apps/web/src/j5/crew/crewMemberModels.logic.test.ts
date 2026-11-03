import {
  ProviderInstanceId,
  type OrchestrationV2AgentPersonaCatalog,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crewMemberModelLabel,
  crewMemberModelsSummary,
  personasOffCrewMemberModels,
  setCrewMemberModelChecked,
  setCrewMemberProviderChecked,
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
