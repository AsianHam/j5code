import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  agentPersonaModelSelection,
  buildAgentPersonaCatalog,
  resolveAgentPersonaRoute,
} from "./agentPersonaRouting.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";
import { listBuiltInAgentPersonas, type AgentModelTarget } from "./agentPersonas.ts";

function model(
  slug: string,
  optionId: string,
  efforts: ReadonlyArray<string> = ["medium", "high"],
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: optionId,
          label: "Reasoning",
          type: "select",
          options: efforts.map((effort) => ({ id: effort, label: effort })),
        },
      ],
    },
  };
}

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly status?: ServerProvider["status"];
  readonly authStatus?: ServerProvider["auth"]["status"];
  readonly availability?: ServerProvider["availability"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    availability: input.availability ?? "available",
    models: input.models,
    slashCommands: [],
    skills: [],
  };
}

function providerForTarget(
  target: AgentModelTarget,
  overrides?: { readonly enabled?: boolean },
): ServerProvider {
  return provider({
    instanceId: target.driver,
    driver: target.driver,
    models: [
      model(target.model, target.driver === "codex" ? "reasoningEffort" : "effort", [
        target.reasoningEffort,
      ]),
    ],
    ...(overrides?.enabled === undefined ? {} : { enabled: overrides.enabled }),
  });
}

describe("agent persona routing", () => {
  it("uses every enforceable persona's declared primary route when it is available", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const [primary, fallback] = definition.modelRoute;
      const resolution = resolveAgentPersonaRoute({
        personaId: definition.id,
        providers: [providerForTarget(fallback), providerForTarget(primary)],
      });

      const enforceable = providerCanEnforceAgentPersonaAuthority(
        primary.driver,
        definition.authority.defaultPolicy,
      );
      assert.equal(resolution.status, enforceable ? "available" : "unavailable", definition.id);
      if (resolution.status === "unavailable") continue;
      assert.equal(resolution.route, "primary", definition.id);
      assert.equal(resolution.driver, primary.driver, definition.id);
      assert.equal(resolution.modelSelection.model, primary.model, definition.id);
    }
  });

  it("uses only an enforceable declared fallback after its primary is unavailable", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const [primary, fallback] = definition.modelRoute;
      const resolution = resolveAgentPersonaRoute({
        personaId: definition.id,
        providers: [providerForTarget(primary, { enabled: false }), providerForTarget(fallback)],
      });

      const enforceable = providerCanEnforceAgentPersonaAuthority(
        fallback.driver,
        definition.authority.defaultPolicy,
      );
      assert.equal(resolution.status, enforceable ? "available" : "unavailable", definition.id);
      if (resolution.status === "unavailable") continue;
      assert.equal(resolution.route, "fallback", definition.id);
      assert.equal(resolution.driver, fallback.driver, definition.id);
      assert.equal(resolution.modelSelection.model, fallback.model, definition.id);
      assert.deepEqual(
        resolution.rejectedTargets.map(({ target }) => target),
        [primary],
      );
    }
  });

  it("skips Claude and uses the Codex fallback for Critic Fix Mode", () => {
    const definition = listBuiltInAgentPersonas().find(({ id }) => id === "critic")!;
    const [primary, fallback] = definition.modelRoute;
    const resolution = resolveAgentPersonaRoute({
      personaId: "critic",
      authorityPolicy: "critic-fix",
      providers: [providerForTarget(primary), providerForTarget(fallback)],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.route, "fallback");
    assert.equal(resolution.driver, "codex");
    assert.deepEqual(
      resolution.rejectedTargets[0]?.failures.map(({ code }) => code),
      ["authority-not-enforceable"],
    );
  });

  it("blocks Builder fallback, Investigator, and Publisher when authority cannot be enforced", () => {
    for (const personaId of ["builder", "investigator", "publisher"] as const) {
      const definition = listBuiltInAgentPersonas().find(({ id }) => id === personaId)!;
      const [primary, fallback] = definition.modelRoute;
      const providers =
        personaId === "builder"
          ? [providerForTarget(primary, { enabled: false }), providerForTarget(fallback)]
          : [providerForTarget(primary), providerForTarget(fallback)];
      const resolution = resolveAgentPersonaRoute({ personaId, providers });

      assert.equal(resolution.status, "unavailable", personaId);
      if (resolution.status === "available") continue;
      assert.isTrue(
        resolution.attempts.some(({ failures }) =>
          failures.some(({ code }) => code === "authority-not-enforceable"),
        ),
        personaId,
      );
    }
  });

  it("reports each rejected route with its target and failure codes in the catalog", () => {
    const scout = listBuiltInAgentPersonas().find(({ id }) => id === "scout")!;
    const [primary, fallback] = scout.modelRoute;
    const catalog = buildAgentPersonaCatalog(
      [
        providerForTarget(primary, { enabled: false }),
        providerForTarget({ ...fallback, model: "some-other-model" }),
      ],
      [scout],
    );
    const availability = catalog.personas[0]!.availability;
    assert.equal(availability.status, "unavailable");
    if (availability.status === "available") return;
    assert.deepEqual(availability.attempts, [
      {
        route: "primary",
        driver: primary.driver,
        model: primary.model,
        reasoningEffort: primary.reasoningEffort,
        failures: ["provider-disabled"],
      },
      {
        route: "fallback",
        driver: fallback.driver,
        model: fallback.model,
        reasoningEffort: fallback.reasoningEffort,
        failures: ["model-not-advertised"],
      },
    ]);
  });

  it("blocks every persona when both declared routes are unavailable", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const resolution = resolveAgentPersonaRoute({
        personaId: definition.id,
        providers: [],
      });

      assert.equal(resolution.status, "unavailable", definition.id);
      if (resolution.status === "available") continue;
      assert.deepEqual(
        resolution.attempts.map(({ target }) => target),
        [...definition.modelRoute],
      );
      assert.deepEqual(
        resolution.attempts.map(({ failures }) => failures.map(({ code }) => code)),
        definition.modelRoute.map((target) =>
          providerCanEnforceAgentPersonaAuthority(target.driver, definition.authority.defaultPolicy)
            ? ["provider-not-configured"]
            : ["authority-not-enforceable", "provider-not-configured"],
        ),
      );
    }
  });

  it("selects the primary provider, exact model, and provider-specific effort option", () => {
    const resolution = resolveAgentPersonaRoute({
      personaId: "scout",
      providers: [
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
    });

    assert.deepEqual(resolution, {
      status: "available",
      personaId: "scout",
      definitionVersion: 1,
      route: "primary",
      driver: ProviderDriverKind.make("codex"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      rejectedTargets: [],
    });
  });

  it("routes any signed-in provider and reports when it cannot enforce the persona's authority", () => {
    const [scout] = listBuiltInAgentPersonas();
    const cursorRoute = {
      driver: ProviderDriverKind.make("cursor"),
      model: "gpt-5.5",
      reasoningEffort: "high",
    };
    const resolution = resolveAgentPersonaRoute({
      personaId: scout!.id,
      definition: { ...scout!, modelRoute: [cursorRoute, cursorRoute] },
      providers: [
        provider({ instanceId: "cursor", driver: "cursor", models: [model("gpt-5.5", "effort")] }),
      ],
    });

    assert.equal(resolution.status, "unavailable");
    if (resolution.status !== "unavailable") return;
    assert.deepEqual(
      resolution.attempts.map(({ target, failures }) => [String(target.driver), failures]),
      [
        ["cursor", [{ code: "authority-not-enforceable" }]],
        ["cursor", [{ code: "authority-not-enforceable" }]],
      ],
    );
  });

  it("routes a full-access persona to a Cursor route", () => {
    const [scout] = listBuiltInAgentPersonas();
    const cursorRoute = {
      driver: ProviderDriverKind.make("cursor"),
      model: "gpt-5.5",
      reasoningEffort: "high",
    };
    const resolution = resolveAgentPersonaRoute({
      personaId: scout!.id,
      definition: {
        ...scout!,
        authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
        modelRoute: [cursorRoute, cursorRoute],
      },
      providers: [
        provider({ instanceId: "cursor", driver: "cursor", models: [model("gpt-5.5", "effort")] }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status !== "available") return;
    assert.equal(String(resolution.driver), "cursor");
  });

  it("names a missing provider alongside an unenforceable one", () => {
    const [scout] = listBuiltInAgentPersonas();
    const typo = {
      driver: ProviderDriverKind.make("claude"),
      model: "claude-opus-5",
      reasoningEffort: "high",
    };
    const resolution = resolveAgentPersonaRoute({
      personaId: scout!.id,
      definition: { ...scout!, modelRoute: [typo, typo] },
      providers: [],
    });

    assert.equal(resolution.status, "unavailable");
    if (resolution.status !== "unavailable") return;
    assert.deepEqual(
      resolution.attempts.map(({ failures }) => failures),
      [
        [{ code: "authority-not-enforceable" }, { code: "provider-not-configured" }],
        [{ code: "authority-not-enforceable" }, { code: "provider-not-configured" }],
      ],
    );
  });

  it("launches with the model's own reasoning option id", () => {
    const selection = (driver: string, optionId: string) =>
      agentPersonaModelSelection(
        provider({ instanceId: driver, driver, models: [model("m", optionId)] }),
        { driver: ProviderDriverKind.make(driver), model: "m", reasoningEffort: "high" },
      ).options;

    assert.deepEqual(selection("opencode", "variant"), [{ id: "variant", value: "high" }]);
    assert.deepEqual(selection("cursor", "reasoning"), [{ id: "reasoning", value: "high" }]);
    assert.deepEqual(selection("pi", "thinking"), [{ id: "thinking", value: "high" }]);
  });

  it("uses fallback only after recording why the primary is ineligible", () => {
    const resolution = resolveAgentPersonaRoute({
      personaId: "skeptic",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          models: [model("claude-opus-5", "effort")],
        }),
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.route, "fallback");
    assert.equal(resolution.modelSelection.instanceId, "codex");
    assert.deepEqual(resolution.rejectedTargets, [
      {
        route: "primary",
        target: {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5",
          reasoningEffort: "high",
        },
        failures: [
          {
            code: "provider-disabled",
            instanceId: ProviderInstanceId.make("claudeAgent"),
          },
        ],
      },
    ]);
  });

  it("prefers the default instance before configured custom instances", () => {
    const terra = model("gpt-5.6-terra", "reasoningEffort");
    const resolution = resolveAgentPersonaRoute({
      personaId: "scout",
      providers: [
        provider({
          instanceId: "codex_work",
          driver: ProviderDriverKind.make("codex"),
          models: [terra],
        }),
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [terra],
        }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.modelSelection.instanceId, "codex");
  });

  it("fails closed when neither target advertises the exact model and effort", () => {
    const resolution = resolveAgentPersonaRoute({
      personaId: "skeptic",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [model("claude-sonnet-5", "effort")],
        }),
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [model("gpt-5.6-terra", "reasoningEffort", ["medium"])],
        }),
      ],
    });

    assert.equal(resolution.status, "unavailable");
    if (resolution.status === "available") return;
    assert.deepEqual(
      resolution.attempts.map(({ failures }) => failures.map(({ code }) => code)),
      [["model-not-advertised"], ["reasoning-effort-not-advertised"]],
    );
  });

  it("builds the ordered presentation catalog with environment-specific availability", () => {
    const catalog = buildAgentPersonaCatalog(
      [
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
      listBuiltInAgentPersonas(),
    );

    assert.equal(catalog.personas.length, 11);
    assert.equal(catalog.personas[0]?.personaId, "scout");
    assert.equal(catalog.personas[0]?.definitionVersion, 1);
    assert.equal(catalog.personas[0]?.acceptedInput, "Evidence request or prompt");
    assert.equal(catalog.personas[0]?.outputArtifact, "ContextBrief");
    assert.deepEqual(catalog.personas[0]?.availability, {
      status: "available",
      resolvedRoute: "primary",
      resolvedDriver: ProviderDriverKind.make("codex"),
      resolvedModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    assert.equal(
      catalog.personas.find(({ personaId }) => personaId === "builder")?.availability.status,
      "unavailable",
    );
    const publisher = catalog.personas.find(({ personaId }) => personaId === "publisher")!;
    assert.equal(publisher.availability.status, "unavailable");
    if (publisher.availability.status === "unavailable") {
      assert.equal(publisher.availability.reason, "authority-not-enforceable");
      assert.deepEqual(
        publisher.availability.attempts?.map(({ failures }) => failures),
        [["authority-not-enforceable"], ["authority-not-enforceable", "provider-not-configured"]],
      );
    }
  });
});

it("presents imported definitions without transmitting their instruction bodies", () => {
  const definition = {
    ...listBuiltInAgentPersonas()[0]!,
    id: "team-researcher",
    displayName: "Team Researcher",
  };
  const catalog = buildAgentPersonaCatalog(
    [providerForTarget(definition.modelRoute[0])],
    [definition],
  );
  assert.lengthOf(catalog.personas, 1);
  assert.equal(catalog.personas[0]?.personaId, "team-researcher");
  assert.equal(catalog.personas[0]?.availability.status, "available");
  assert.notProperty(catalog.personas[0], "instructions");
  assert.deepEqual(buildAgentPersonaCatalog([], []), { personas: [] });
});
