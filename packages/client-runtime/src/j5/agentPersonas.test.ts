import {
  BUILT_IN_AGENT_PERSONA_IDS,
  AgentPersonaImportConflictError,
  type AgentPersonaImportInput,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2AgentPersonaCatalog,
  OrchestrationV2ShellSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { agentPersonaMentionItems } from "./agentMentions.ts";

import {
  prepareAgentPersonaImport,
  importAgentPersonasWithConfirmation,
  agentPersonaDrift,
  agentPersonaFolderNudges,
  agentPersonaFolderStatusLabel,
  agentPersonaOriginLabel,
  agentPersonaUsageById,
  formatAgentPersonaDuration,
  presentAgentHandoff,
  presentAgentPersonaUsage,
  draftAgentAssignmentPreview,
  agentPersonaDuplicateDraft,
  agentPersonaIdError,
  agentPersonaIdFromName,
  agentPersonaPolicyDrivers,
  AGENT_PERSONA_POLICY_OPTIONS,
  agentPersonaPolicyNote,
  defaultAgentPersonaModelRoute,
  agentPersonaModelChoices,
  agentPersonaModelGroups,
  presentAgentPersonaAssignment,
  presentAgentPersonaCatalog,
} from "./agentPersonas.ts";

const catalog: OrchestrationV2AgentPersonaCatalog = {
  personas: BUILT_IN_AGENT_PERSONA_IDS.map((personaId, index) => ({
    personaId,
    definitionVersion: 1,
    displayName: personaId,
    description: `${personaId} description`,
    acceptedInput: `${personaId} input`,
    outputArtifact: "ContextBrief",
    defaultAuthorityPolicy: "read-only",
    allowedAuthorityPolicies: ["read-only"],
    availability:
      index === 0
        ? {
            status: "available",
            resolvedRoute: "fallback",
            resolvedDriver: ProviderDriverKind.make("codex"),
            resolvedModelSelection: {
              instanceId: ProviderInstanceId.make("remote-codex"),
              model: "server-selected-model",
            },
          }
        : { status: "unavailable", reason: "routes-unavailable" },
  })),
};

describe("agent persona catalog presentation", () => {
  it("presents a durable assignment with its immutable provider route", () => {
    expect(
      presentAgentPersonaAssignment({
        personaId: "critic",
        definitionVersion: 1,
        authorityPolicy: "critic-fix",
        resolvedRoute: "fallback",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("remote-codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    ).toEqual({
      personaLabel: "Critic · Fix",
      routeLabel: "Codex · gpt-5.6-terra · high",
    });
    expect(
      presentAgentPersonaAssignment({
        personaId: "scout",
        definitionVersion: 1,
        authorityPolicy: "read-only",
        runtimeModeOverride: "full-access",
        resolvedRoute: "override",
        resolvedDriver: ProviderDriverKind.make("opencode"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "glm-5",
          options: [{ id: "variant", value: "high" }],
        },
      }).routeLabel,
    ).toBe("OpenCode · glm-5 · high");
  });

  it("preserves all twelve server-provided personas for every client", () => {
    expect(presentAgentPersonaCatalog(catalog).map(({ personaId }) => personaId)).toEqual([
      ...BUILT_IN_AGENT_PERSONA_IDS,
    ]);
  });

  it("presents the server-resolved remote route without recalculating it", () => {
    expect(presentAgentPersonaCatalog(catalog)[0]).toMatchObject({
      availability: "available",
      availabilityLabel: "Available",
      route: "Codex · server-selected-model · fallback",
    });
  });

  it("presents unavailable personas as clearly blocked", () => {
    expect(presentAgentPersonaCatalog(catalog)[1]).toMatchObject({
      availability: "blocked",
      availabilityLabel: "Blocked",
      route: "Primary and fallback models unavailable",
    });
  });

  it("distinguishes an unenforceable authority boundary from missing models", () => {
    const authorityBlocked = {
      personas: [
        {
          ...catalog.personas[1]!,
          availability: {
            status: "unavailable" as const,
            reason: "authority-not-enforceable" as const,
          },
        },
      ],
    };

    expect(presentAgentPersonaCatalog(authorityBlocked)[0]?.route).toBe(
      "Required authority is not yet enforceable",
    );
  });
});

it("presents custom library ids and immutable display names on every client", () => {
  const custom = {
    ...catalog.personas[0]!,
    personaId: "team-researcher",
    displayName: "Team Researcher",
    outputArtifact: "TeamBrief",
  };
  expect(presentAgentPersonaCatalog({ personas: [custom] })[0]).toMatchObject({
    personaId: "team-researcher",
    displayName: "Team Researcher",
    outputArtifact: "TeamBrief",
  });
  expect(
    presentAgentPersonaAssignment({
      personaId: custom.personaId,
      displayName: "Original Researcher",
      definitionVersion: 2,
      definitionDigest: "a".repeat(64),
      authorityPolicy: "read-only",
      resolvedRoute: "primary",
      resolvedDriver: ProviderDriverKind.make("codex"),
      resolvedModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "research-model",
      },
    }).personaLabel,
  ).toBe("Original Researcher");
  expect(presentAgentPersonaCatalog({ personas: [] })).toEqual([]);
});

describe("persona import selection", () => {
  const file = (name: string, content = "{}", size = content.length) => ({
    name,
    size,
    text: async () => content,
  });
  it("includes nested YAML definitions and skips JSON files and documentation unread", async () => {
    const unread = (name: string) => ({
      name,
      size: 1,
      text: async () => {
        throw new Error("Must not read");
      },
    });
    expect(
      await prepareAgentPersonaImport([
        file("team/one/agent.yaml", "one"),
        file("team/two/agent.YAML", "two"),
        file("team/three/agent.yml", "three"),
        file("team/four/agent.YML", "four"),
        unread("team/legacy/agent.json"),
        unread("team/README.md"),
      ]),
    ).toEqual([
      { name: "team/one/agent.yaml", content: "one" },
      { name: "team/two/agent.YAML", content: "two" },
      { name: "team/three/agent.yml", content: "three" },
      { name: "team/four/agent.YML", content: "four" },
    ]);
  });
  it("imports only the selected individual definition", async () => {
    expect(await prepareAgentPersonaImport([file("agent.yaml", "selected")])).toEqual([
      { name: "agent.yaml", content: "selected" },
    ]);
  });
  it("reports empty folders and file limits before reading oversized selections", async () => {
    await expect(prepareAgentPersonaImport([file("README.md")])).rejects.toThrow("No YAML");
    await expect(prepareAgentPersonaImport([file("big.yaml", "", 65537)])).rejects.toThrow(
      "64 KiB",
    );
    await expect(
      prepareAgentPersonaImport(Array.from({ length: 51 }, () => file("agent.yaml"))),
    ).rejects.toThrow("at most 50");
  });
  it("identifies removable imports while treating older catalog entries as source definitions", () => {
    const persona = catalog.personas[0]!;
    expect(presentAgentPersonaCatalog({ personas: [persona] })[0]?.imported).toBe(false);
    expect(
      presentAgentPersonaCatalog({ personas: [{ ...persona, imported: true }] })[0]?.imported,
    ).toBe(true);
  });
});

it("shows disabled imports as off and distinguishes them from enabled agents with unavailable models", () => {
  const persona = catalog.personas[1]!;
  const disabled = presentAgentPersonaCatalog({
    personas: [
      { ...persona, imported: true, availability: { status: "unavailable", reason: "disabled" } },
    ],
  })[0];
  expect(disabled).toMatchObject({
    imported: true,
    enabled: false,
    availability: "disabled",
    availabilityLabel: "Disabled",
    route: "Disabled for new launches",
  });
  expect(presentAgentPersonaCatalog({ personas: [persona] })[0]).toMatchObject({
    enabled: true,
    availability: "blocked",
  });
});

it("offers editing only for imported entries with server-provided editable details", () => {
  const persona = catalog.personas[0]!;
  expect(presentAgentPersonaCatalog({ personas: [persona] })[0]?.edit).toBeNull();
  const modelRoute = [
    { driver: ProviderDriverKind.make("codex"), model: "custom-model", reasoningEffort: "high" },
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      model: "fallback-model",
      reasoningEffort: "medium",
    },
  ] as const;
  expect(
    presentAgentPersonaCatalog({
      personas: [
        { ...persona, imported: true, editable: { definitionDigest: "a".repeat(64), modelRoute } },
      ],
    })[0]?.edit,
  ).toEqual({
    personaId: persona.personaId,
    expectedDigest: "a".repeat(64),
    displayName: persona.displayName,
    description: persona.description,
    authorityPolicy: persona.defaultAuthorityPolicy,
    modelRoute,
  });
  const choices = agentPersonaModelChoices([], modelRoute);
  expect(choices).toHaveLength(2);
  expect(choices.find(({ target }) => target.driver === "codex")?.efforts).toEqual(["high"]);
  expect(choices.every(({ label }) => label.includes("not advertised"))).toBe(true);
});

it("uses the selected environment's advertised models and reasoning options without duplicating instances", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("remote-codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-08T00:00:00.000Z",
    availability: "available",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "team-model",
        name: "Team model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
                { id: "minimal", label: "Minimal" },
                { id: "max", label: "Max" },
              ],
            },
          ],
        },
      },
    ],
  };
  const choices = agentPersonaModelChoices(
    [provider, { ...provider, instanceId: ProviderInstanceId.make("second-codex") }],
    [{ driver: ProviderDriverKind.make("codex"), model: "team-model", reasoningEffort: "xhigh" }],
  );
  for (const unavailable of [
    { ...provider, auth: { status: "unauthenticated" as const } },
    { ...provider, auth: { status: "unknown" as const } },
    { ...provider, enabled: false },
    { ...provider, installed: false },
  ]) {
    expect(agentPersonaModelChoices([unavailable], [])).toEqual([]);
    const configured = agentPersonaModelChoices([unavailable], [choices[0]!.target]);
    expect(configured).toHaveLength(1);
    expect(configured[0]?.available).toBe(false);
  }
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    available: true,
    label: "Codex · team-model",
    target: {
      driver: ProviderDriverKind.make("codex"),
      model: "team-model",
      reasoningEffort: "high",
    },
    efforts: ["xhigh", "high", "medium", "minimal", "max"],
  });
});

it("offers every signed-in harness with its own reasoning option", () => {
  const cursor: ServerProvider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    availability: "available",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            { id: "fastMode", label: "Fast", type: "boolean" },
            {
              id: "reasoning",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      {
        slug: "composer-2",
        name: "Composer 2",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ],
  };
  const choices = agentPersonaModelChoices([cursor], []);
  expect(choices).toMatchObject([
    {
      label: "Cursor · gpt-5.5",
      target: { driver: "cursor", model: "gpt-5.5", reasoningEffort: "high" },
      efforts: ["low", "high"],
    },
  ]);
  expect(agentPersonaModelGroups(choices)).toMatchObject([{ driver: "cursor", label: "Cursor" }]);
});

it("retains unadvertised models and their configured reasoning levels", () => {
  const current = [
    { driver: ProviderDriverKind.make("codex"), model: "legacy-model", reasoningEffort: "xhigh" },
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      model: "custom-model",
      reasoningEffort: "low",
    },
  ] as const;
  const choices = agentPersonaModelChoices([], current);
  expect(choices.find(({ target }) => target.model === "legacy-model")).toMatchObject({
    target: current[0],
    efforts: ["xhigh"],
  });
  expect(choices.find(({ target }) => target.model === "custom-model")?.efforts).toEqual(["low"]);
  expect(current[0].reasoningEffort).toBe("xhigh");
});

it("merges all configured reasoning levels for a shared unadvertised model", () => {
  const choices = agentPersonaModelChoices(
    [],
    [
      { driver: ProviderDriverKind.make("codex"), model: "custom-model", reasoningEffort: "low" },
      { driver: ProviderDriverKind.make("codex"), model: "custom-model", reasoningEffort: "high" },
      { driver: ProviderDriverKind.make("codex"), model: "custom-model", reasoningEffort: "xhigh" },
    ],
  );
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    target: {
      driver: ProviderDriverKind.make("codex"),
      model: "custom-model",
      reasoningEffort: "xhigh",
    },
    efforts: ["low", "high", "xhigh"],
  });
});

describe("import replacement confirmation", () => {
  const files = [{ name: "agent.yaml", content: "selected content" }];
  const conflict = new AgentPersonaImportConflictError({
    message: "Already exists",
    conflicts: [{ personaId: "scout", displayName: "Scout", definitionDigest: "a".repeat(64) }],
  });

  it("imports a new selection without showing confirmation", async () => {
    let prompts = 0;
    const result = await importAgentPersonasWithConfirmation(
      files,
      async (input) => {
        expect(input).toEqual({ files, replaceExisting: false });
        return { importedIds: ["scout"] };
      },
      async () => {
        prompts++;
        return null;
      },
    );
    expect(result?.importedIds).toEqual(["scout"]);
    expect(prompts).toBe(0);
  });

  it("cancels without sending a replacement request", async () => {
    const requests: AgentPersonaImportInput[] = [];
    const result = await importAgentPersonasWithConfirmation(
      files,
      async (input) => {
        requests.push(input);
        throw conflict;
      },
      async () => null,
    );
    expect(result).toBeNull();
    expect(requests).toEqual([{ files, replaceExisting: false }]);
  });

  it("retries the same files with the exact conflicts the user approved", async () => {
    const requests: AgentPersonaImportInput[] = [];
    const result = await importAgentPersonasWithConfirmation(
      files,
      async (input) => {
        requests.push(input);
        if (!input.replaceExisting) throw conflict;
        return { importedIds: ["scout"] };
      },
      async (error) => {
        expect(error.conflicts).toEqual(conflict.conflicts);
        return error.conflicts;
      },
    );
    expect(requests[1]).toEqual({
      files,
      replaceExisting: true,
      confirmedConflicts: conflict.conflicts,
      skippedPersonaIds: [],
    });
    expect(result?.importedIds).toEqual(["scout"]);
  });

  it("asks again on changed conflicts and propagates unrelated failures without prompting", async () => {
    const changed = new AgentPersonaImportConflictError({
      message: "Changed",
      conflicts: [{ ...conflict.conflicts[0]!, definitionDigest: "b".repeat(64) }],
    });
    let requests = 0;
    let prompts = 0;
    const result = await importAgentPersonasWithConfirmation(
      files,
      async () => {
        throw requests++ === 0 ? conflict : changed;
      },
      async (error) => (++prompts === 1 ? error.conflicts : null),
    );
    expect(result).toBeNull();
    expect(requests).toBe(2);
    expect(prompts).toBe(2);
    await expect(
      importAgentPersonasWithConfirmation(
        files,
        async () => {
          throw new Error("Invalid JSON");
        },
        async () => {
          throw new Error("Should not prompt");
        },
      ),
    ).rejects.toThrow("Invalid JSON");
  });
});

it("retains skipped agents through fresh confirmation and accepts an empty replacement selection", async () => {
  const files = [{ name: "folder/agent.yaml", content: "selected content" }];
  const first = new AgentPersonaImportConflictError({
    message: "Already exists",
    conflicts: [
      { personaId: "keep", displayName: "Keep", definitionDigest: "a".repeat(64) },
      { personaId: "replace", displayName: "Replace", definitionDigest: "b".repeat(64) },
    ],
  });
  const changed = new AgentPersonaImportConflictError({
    message: "Changed",
    conflicts: [{ ...first.conflicts[1]!, definitionDigest: "c".repeat(64) }],
  });
  const requests: AgentPersonaImportInput[] = [];
  let prompts = 0;
  const result = await importAgentPersonasWithConfirmation(
    files,
    async (input) => {
      requests.push(input);
      if (requests.length === 1) throw first;
      if (requests.length === 2) throw changed;
      return { importedIds: ["new-agent"] };
    },
    async (error) =>
      ++prompts === 1 ? error.conflicts.filter(({ personaId }) => personaId === "replace") : [],
  );
  expect(requests[1]).toEqual({
    files,
    replaceExisting: true,
    confirmedConflicts: [first.conflicts[1]],
    skippedPersonaIds: ["keep"],
  });
  expect(requests[2]).toEqual({
    files,
    replaceExisting: true,
    confirmedConflicts: [],
    skippedPersonaIds: ["keep", "replace"],
  });
  expect(result?.importedIds).toEqual(["new-agent"]);
});

it("presents removed source agents as restorable and never launchable", () => {
  const persona = catalog.personas[1]!;
  const removed = presentAgentPersonaCatalog({
    personas: [
      { ...persona, removed: true, availability: { status: "unavailable", reason: "removed" } },
    ],
  })[0];
  expect(removed).toMatchObject({
    imported: false,
    removed: true,
    enabled: false,
    availability: "removed",
    availabilityLabel: "Removed",
    route: "Removed from this library",
  });
  expect(presentAgentPersonaCatalog({ personas: [persona] })[0]?.removed).toBe(false);
});

const provider = (
  driver: string,
  instanceId: string,
  models: ReadonlyArray<string>,
  optionId: string,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-10T00:00:00.000Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: models.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: optionId,
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  })),
});

describe("personal agent authoring", () => {
  it("derives stable IDs from names and explains invalid ones", () => {
    expect(agentPersonaIdFromName("  Team Researcher! ")).toBe("team-researcher");
    expect(agentPersonaIdFromName("2nd Reviewer")).toBe("agent-2nd-reviewer");
    expect(agentPersonaIdFromName("---")).toBe("");
    expect(agentPersonaIdError("team-researcher")).toBeNull();
    expect(agentPersonaIdError("")).toBe("Enter an ID.");
    expect(agentPersonaIdError("Team Researcher")).toMatch(/lowercase/);
    expect(agentPersonaIdError("-lead")).toMatch(/starting with a letter/);
  });

  it("picks a launchable default route and prefers a second harness for the fallback", () => {
    expect(defaultAgentPersonaModelRoute([])).toBeNull();
    const providers = [
      provider("codex", "codex", ["gpt-5.6-terra"], "reasoningEffort"),
      provider("claudeAgent", "claude", ["claude-opus-5"], "effort"),
    ];
    expect(defaultAgentPersonaModelRoute(providers)).toEqual([
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-opus-5",
        reasoningEffort: "high",
      },
      { driver: ProviderDriverKind.make("codex"), model: "gpt-5.6-terra", reasoningEffort: "high" },
    ]);
    const single = defaultAgentPersonaModelRoute([providers[0]!]);
    expect(single?.[0]).toEqual(single?.[1]);
    const cursor = provider("cursor", "cursor", ["composer-2"], "reasoning");
    const withCursor = defaultAgentPersonaModelRoute(
      [cursor, providers[0]!],
      [ProviderDriverKind.make("codex")],
    );
    expect(withCursor?.map(({ driver }) => String(driver))).toEqual(["codex", "codex"]);
    // With no sandboxing driver signed in, any advertised model still makes a starting route.
    expect(
      defaultAgentPersonaModelRoute([cursor], [ProviderDriverKind.make("codex")])?.[0],
    ).toEqual({
      driver: ProviderDriverKind.make("cursor"),
      model: "composer-2",
      reasoningEffort: "high",
    });
  });

  it("says where the selected policy is sandboxed and which routes won't launch", () => {
    const catalog = {
      personas: [],
      policyEnforcement: [
        {
          policy: "read-only" as const,
          drivers: [ProviderDriverKind.make("codex"), ProviderDriverKind.make("claudeAgent")],
        },
        { policy: "publish-only" as const, drivers: [] },
      ],
    };
    const target = (driver: string) => ({
      driver: ProviderDriverKind.make(driver),
      model: "m",
      reasoningEffort: "high",
    });
    const readOnly = agentPersonaPolicyDrivers(catalog, "read-only");
    expect(agentPersonaPolicyNote(readOnly, [target("codex"), target("claudeAgent")])).toBe(
      "Sandboxed on Codex and Claude.",
    );
    expect(agentPersonaPolicyNote(readOnly, [target("cursor"), target("codex")])).toBe(
      "Sandboxed on Codex and Claude. Cursor routes won't launch with this policy.",
    );
    expect(
      agentPersonaPolicyNote(agentPersonaPolicyDrivers(catalog, "publish-only"), [target("codex")]),
    ).toBe("No provider can sandbox this policy yet, so it won't launch.");
    const fullAccess = agentPersonaPolicyDrivers(
      {
        personas: [],
        policyEnforcement: [
          {
            policy: "full-access" as const,
            drivers: [ProviderDriverKind.make("codex"), ProviderDriverKind.make("cursor")],
          },
        ],
      },
      "full-access",
    );
    expect(agentPersonaPolicyNote(fullAccess, [target("codex")], "full-access")).toBe(
      "Unsandboxed: runs with full access on Codex and Cursor.",
    );
    expect(agentPersonaPolicyNote(fullAccess, [target("claudeAgent")], "full-access")).toBe(
      "Unsandboxed: runs with full access on Codex and Cursor. Claude routes won't launch with this policy.",
    );
    // An older server sends no table; the editor says nothing rather than guessing.
    expect(
      agentPersonaPolicyNote(agentPersonaPolicyDrivers({ personas: [] }, "read-only"), []),
    ).toBeNull();
  });
});

it("prefills a duplicate with the source content and a fresh name and ID", () => {
  expect(
    agentPersonaDuplicateDraft({
      id: "scout",
      version: 3,
      displayName: "Scout",
      description: "Collects evidence.",
      instructions: "# Scout",
      authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only", "critic-review"] },
      modelRoute: [
        {
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
        },
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5",
          reasoningEffort: "high",
        },
      ],
    }),
  ).toEqual({
    displayName: "Scout copy",
    id: "scout-copy",
    description: "Collects evidence.",
    instructions: "# Scout",
    authorityPolicy: "read-only",
    modelRoute: [
      { driver: ProviderDriverKind.make("codex"), model: "gpt-5.6-terra", reasoningEffort: "high" },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-opus-5",
        reasoningEffort: "high",
      },
    ],
  });
});

it("labels the full-access policy and offers it in the editor", () => {
  expect(AGENT_PERSONA_POLICY_OPTIONS.find(({ value }) => value === "full-access")).toEqual({
    value: "full-access",
    label: "Full access (unsandboxed)",
  });
  const row = presentAgentPersonaCatalog({
    personas: [
      {
        ...catalog.personas[0]!,
        defaultAuthorityPolicy: "read-only",
        allowedAuthorityPolicies: ["read-only", "full-access"],
      },
    ],
  })[0];
  expect(row?.authority).toBe("Read only (default), Full access");
  expect(row?.unsandboxed).toBe(true);
  expect(presentAgentPersonaCatalog(catalog)[0]?.unsandboxed).toBe(false);
  expect(
    agentPersonaDuplicateDraft({
      id: "operator",
      version: 1,
      displayName: "Operator",
      description: "Operates.",
      instructions: "# Operator",
      authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
      modelRoute: [
        { driver: ProviderDriverKind.make("codex"), model: "m", reasoningEffort: "high" },
        { driver: ProviderDriverKind.make("cursor"), model: "m", reasoningEffort: "high" },
      ],
    }).authorityPolicy,
  ).toBe("full-access");
});

const decodeCatalogJson = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2AgentPersonaCatalog),
);
const decodeShellSnapshotJson = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ShellSnapshot),
);

describe("a policy this app does not know", () => {
  const invented = "sandboxed-network";
  const route = {
    status: "available",
    resolvedRoute: "primary",
    resolvedDriver: "codex",
    resolvedModelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
  };
  const entry = (personaId: string, defaultAuthorityPolicy: string) => ({
    personaId,
    imported: true,
    editable: {
      definitionDigest: "a".repeat(64),
      modelRoute: [
        { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
        { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
      ],
    },
    definitionVersion: 1,
    displayName: personaId,
    description: `${personaId} description`,
    defaultAuthorityPolicy,
    allowedAuthorityPolicies: [defaultAuthorityPolicy, "read-only"],
    availability: route,
  });
  const thread = (id: string, authorityPolicy: string) => ({
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: "project-1",
    title: id,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    agentPersonaAssignment: {
      personaId: "scout",
      definitionVersion: 1,
      authorityPolicy,
      resolvedRoute: "primary",
      resolvedDriver: "codex",
      resolvedModelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    },
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });

  it("costs one unsupported row, not the catalog or the shell snapshot", () => {
    const decoded = decodeCatalogJson({
      personas: [entry("scout", "read-only"), entry("future", invented)],
      policyEnforcement: [
        { policy: "read-only", drivers: ["codex"] },
        { policy: invented, drivers: ["codex"] },
      ],
    });
    const [known, future] = presentAgentPersonaCatalog(decoded);
    expect(known).toMatchObject({ availability: "available", blockedReasons: [] });
    expect(known?.edit?.authorityPolicy).toBe("read-only");
    expect(future).toMatchObject({
      availability: "unsupported",
      availabilityLabel: "Unsupported",
      edit: null,
      authority: `${invented} (unsupported) (default), Read only`,
      blockedReasons: [
        `Runtime policy "${invented}" is not supported by this app version. Update the app to launch this persona.`,
      ],
    });
    // Nothing offers it for launch, and nothing reads it as another policy.
    expect(agentPersonaMentionItems(decoded, "").map(({ personaId }) => personaId)).toEqual([
      "scout",
    ]);
    expect(draftAgentAssignmentPreview("future", decoded)).toBeNull();
    expect(draftAgentAssignmentPreview("scout", decoded)?.authorityPolicy).toBe("read-only");
    expect(agentPersonaPolicyDrivers(decoded, "read-only")).toEqual(["codex"]);

    const shell = decodeShellSnapshotJson({
      schemaVersion: 1,
      snapshotSequence: 7,
      projects: [],
      threads: [thread("thread-known", "read-only"), thread("thread-future", invented)],
      archivedThreads: [],
    });
    expect(
      shell.threads.map(({ id, agentPersonaAssignment }) => [
        id,
        agentPersonaAssignment?.authorityPolicy,
      ]),
    ).toEqual([
      ["thread-known", "read-only"],
      ["thread-future", invented],
    ]);
    expect(
      shell.threads.map(({ agentPersonaAssignment }) =>
        agentPersonaAssignment
          ? presentAgentPersonaAssignment(agentPersonaAssignment).personaLabel
          : null,
      ),
    ).toEqual(["Scout", `Scout · ${invented} (unsupported)`]);
  });

  it("keeps an unsupported row unsupported when it is turned off or removed", () => {
    const rows = presentAgentPersonaCatalog(
      decodeCatalogJson({
        personas: [
          {
            ...entry("off", invented),
            availability: { status: "unavailable", reason: "disabled" },
          },
          {
            ...entry("gone", invented),
            availability: { status: "unavailable", reason: "removed" },
          },
        ],
        policyEnforcement: [],
      }),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        availability: "unsupported",
        blockedReasons: [
          `Runtime policy "${invented}" is not supported by this app version. Update the app to launch this persona.`,
        ],
      });
    }
    expect(rows.map(({ enabled, removed }) => [enabled, removed])).toEqual([
      [false, false],
      [false, true],
    ]);
  });

  it("refuses to duplicate a definition into a policy the editor cannot offer", () => {
    const modelRoute = [
      { driver: ProviderDriverKind.make("codex"), model: "gpt-5.6-terra", reasoningEffort: "high" },
      { driver: ProviderDriverKind.make("codex"), model: "gpt-5.6-terra", reasoningEffort: "high" },
    ] as const;
    expect(() =>
      agentPersonaDuplicateDraft({
        id: "future",
        version: 1,
        displayName: "Future",
        description: "From a newer server.",
        instructions: "# Future",
        authority: { defaultPolicy: invented, allowedPolicies: [invented] },
        modelRoute,
      }),
    ).toThrow(`Runtime policy "${invented}" is not supported by this app version.`);
  });
});

it("reports drift only when both the snapshot and the current definition carry digests", () => {
  const persona = { ...catalog.personas[0]!, definitionDigest: "a".repeat(64) };
  const listed = { personas: [persona] };
  const assignment = { personaId: persona.personaId, definitionDigest: "a".repeat(64) };
  expect(agentPersonaDrift(assignment, listed)).toBe("current");
  expect(agentPersonaDrift({ ...assignment, definitionDigest: "b".repeat(64) }, listed)).toBe(
    "changed",
  );
  expect(agentPersonaDrift({ personaId: persona.personaId }, listed)).toBe("unknown");
  expect(agentPersonaDrift(assignment, { personas: [] })).toBe("unknown");
  expect(agentPersonaDrift(assignment, null)).toBe("unknown");
});

describe("agent usage, origin, and library folders", () => {
  it("summarizes usage densely and omits metrics that were never reported", () => {
    const busy = presentAgentPersonaUsage({
      personaId: "scout",
      threads: 2,
      runs: 4,
      completedRuns: 2,
      failedRuns: 1,
      averageRunDurationMs: 130_000,
      lastLaunchedAt: "2026-09-10T11:00:00.000Z",
      inputTokens: 12_345,
      outputTokens: 900,
      routes: [
        { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5", threads: 1 },
        { driver: ProviderDriverKind.make("codex"), model: "gpt-5.6-terra", threads: 1 },
      ],
    });
    expect(busy.line).toBe(
      "2 tasks · 4 runs · 2 completed · 1 failed · avg 2m 10s · 12.3k in / 900 out · last 2026-09-10",
    );
    expect(busy.routes).toEqual([
      "Claude · claude-opus-5 (1 task)",
      "Codex · gpt-5.6-terra (1 task)",
    ]);
    const idle = presentAgentPersonaUsage({
      personaId: "critic",
      threads: 1,
      runs: 0,
      completedRuns: 0,
      failedRuns: 0,
      averageRunDurationMs: null,
      lastLaunchedAt: null,
      inputTokens: null,
      outputTokens: null,
      routes: [],
    });
    expect(idle.line).toBe("1 task · 0 runs");
    expect(formatAgentPersonaDuration(3_720_000)).toBe("1h 2m");
    expect(agentPersonaUsageById(null).size).toBe(0);
  });

  it("labels origins by kind and names only the parent folder of a source file", () => {
    expect(agentPersonaOriginLabel({ kind: "bundled" })).toBe("Bundled example");
    expect(agentPersonaOriginLabel({ kind: "imported" })).toBe("Personal");
    expect(
      agentPersonaOriginLabel({ kind: "folder", path: "/srv/state/team-library/a.yaml" }),
    ).toBe("Folder · team-library");
    const rows = presentAgentPersonaCatalog({
      personas: [{ ...catalog.personas[0]!, origin: { kind: "imported" } }, catalog.personas[1]!],
    });
    expect(rows[0]?.originLabel).toBe("Personal");
    expect(rows[1]?.origin).toBeNull();
  });

  it("surfaces only the two git nudges the spec allows", () => {
    expect(agentPersonaFolderNudges(null)).toEqual([]);
    expect(
      agentPersonaFolderNudges({ repositoryRoot: "/r", uncommittedChanges: false, remoteAhead: 0 }),
    ).toEqual([]);
    expect(
      agentPersonaFolderNudges({ repositoryRoot: "/r", uncommittedChanges: true, remoteAhead: 1 }),
    ).toEqual([
      "Uncommitted changes in this folder. Commit to share them.",
      "1 new commit on the remote. Pull to update this library.",
    ]);
    expect(
      agentPersonaFolderStatusLabel({
        configuredPath: "personas",
        path: "/s/personas",
        exists: false,
        definitionCount: 0,
        git: null,
      }),
    ).toBe("Missing");
  });
});

it("previews a draft launch from the catalog route and refuses unavailable agents", () => {
  const available = catalog.personas[0]!;
  const preview = draftAgentAssignmentPreview(available.personaId, catalog);
  expect(preview).toMatchObject({
    personaId: available.personaId,
    displayName: available.displayName,
    authorityPolicy: "read-only",
    resolvedRoute: "fallback",
    resolvedModelSelection: { model: "server-selected-model" },
  });
  expect(draftAgentAssignmentPreview(catalog.personas[1]!.personaId, catalog)).toBeNull();
  expect(draftAgentAssignmentPreview("missing", catalog)).toBeNull();
  expect(draftAgentAssignmentPreview(available.personaId, null)).toBeNull();
});

describe("blocked reasons and folder status", () => {
  it("names the missing model or provider for each rejected route", () => {
    const rows = presentAgentPersonaCatalog({
      personas: [
        {
          ...catalog.personas[1]!,
          availability: {
            status: "unavailable",
            reason: "routes-unavailable",
            attempts: [
              {
                route: "primary",
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.6-terra",
                reasoningEffort: "high",
                failures: ["model-not-advertised"],
              },
              {
                route: "fallback",
                driver: ProviderDriverKind.make("claudeAgent"),
                model: "claude-opus-5",
                reasoningEffort: "high",
                failures: ["provider-unauthenticated"],
              },
            ],
          },
        },
        {
          ...catalog.personas[2]!,
          availability: { status: "unavailable", reason: "disabled" },
        },
      ],
    });
    expect(rows[0]?.blockedReasons).toEqual([
      "Primary · Codex gpt-5.6-terra (high): model is not offered by the signed-in provider",
      "Fallback · Claude claude-opus-5 (high): provider is not signed in",
    ]);
    expect(rows[1]?.blockedReasons).toEqual([]);
    expect(rows[1]?.enabled).toBe(false);
  });

  it("treats the unconfigured default folder as absent rather than missing", () => {
    const folder = {
      configuredPath: "personas",
      path: "/s/personas",
      exists: false,
      definitionCount: 0,
      git: null,
    };
    expect(agentPersonaFolderStatusLabel(folder, false)).toBe("Default · not created");
    expect(agentPersonaFolderStatusLabel(folder, true)).toBe("Missing");
  });
});

describe("handoff artifacts", () => {
  it("presents written, pending, and missing handoffs with the logical artifact path", () => {
    const base = {
      threadId: "8f3a2c1d-0000-4000-8000-000000000000",
      projectId: "project",
      personaId: "critic",
      artifact: "ReviewHandoff",
      path: "handoffs/critic/ReviewHandoff-8f3a2c1d.md",
      runId: null,
      checkedAt: "2026-09-14T00:00:00.000Z",
    } as const;
    const written = presentAgentHandoff({ ...base, status: "written" } as never);
    expect(written.tone).toBe("success");
    expect(written.logicalPath).toBe("artifacts/handoffs/critic/ReviewHandoff-8f3a2c1d.md");
    expect(presentAgentHandoff({ ...base, status: "nudged" } as never).label).toBe(
      "ReviewHandoff pending",
    );
    const missing = presentAgentHandoff({ ...base, status: "missing" } as never);
    expect(missing.tone).toBe("error");
    expect(missing.detail).toContain("incomplete");
  });
});
