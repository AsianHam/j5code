import {
  agentPersonaReasoningDescriptor,
  type ModelSelection,
  type OrchestrationV2AgentPersonaCatalog,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  crewMemberLevelCounts,
  crewMemberModelCounts,
  crewMemberProviderLevels,
  crewMemberSelectionLevel,
  eligibleCrewMemberLevelsForModel,
  isCrewMemberLevelChecked,
  isCrewMemberModelChecked,
  isCrewMemberProviderSetUp,
  type CrewMemberModel,
  type CrewMemberModels,
  type CrewMemberReasoning,
  type CrewMemberReasoningLevel,
} from "@t3tools/contracts/j5";

import { setCrewReasoning } from "./crewSeatRuntime";

type ModelKey = Pick<CrewMemberModel, "instanceId" | "model">;

const sameModel = (left: ModelKey, right: ModelKey) =>
  left.instanceId === right.instanceId && left.model === right.model;

/**
 * A model's chip label. The Claude card is already named Claude, so its models drop the prefix; the
 * same models under Cursor keep it, since that is what tells them apart there.
 */
export const crewMemberModelLabel = (provider: ServerProvider, name: string): string =>
  provider.driver === "claudeAgent" ? name.replace(/^Claude\s+/u, "") : name;

/** Every model of every provider a person can choose from, as checked pairs. */
const catalogEntries = (providers: ReadonlyArray<ServerProvider>): ReadonlyArray<CrewMemberModel> =>
  providers
    .filter(isCrewMemberProviderSetUp)
    .flatMap((provider) =>
      provider.models.map((model) => ({ instanceId: provider.instanceId, model: model.slug })),
    );

/**
 * The list after one box is changed. Until a list is saved every model counts as checked, so the
 * first change starts from the whole catalog. Entries for models no longer in the catalog stay:
 * they come back if the model does.
 */
export const setCrewMemberModelChecked = (
  list: CrewMemberModels,
  providers: ReadonlyArray<ServerProvider>,
  model: ModelKey,
  checked: boolean,
): ReadonlyArray<CrewMemberModel> => {
  const base = list ?? catalogEntries(providers);
  const without = base.filter((entry) => !sameModel(entry, model));
  return checked ? [...without, { instanceId: model.instanceId, model: model.model }] : without;
};

/** The list after every model of one provider is checked or unchecked. */
export const setCrewMemberProviderChecked = (
  list: CrewMemberModels,
  providers: ReadonlyArray<ServerProvider>,
  provider: ServerProvider,
  checked: boolean,
): ReadonlyArray<CrewMemberModel> => {
  const base = list ?? catalogEntries(providers);
  const others = base.filter((entry) => entry.instanceId !== provider.instanceId);
  return checked
    ? [
        ...others,
        ...provider.models.map((model) => ({
          instanceId: provider.instanceId,
          model: model.slug,
        })),
      ]
    : others;
};

/** "6 of 12", and whether a saved list leaves no model eligible. */
export const crewMemberModelsSummary = (
  list: CrewMemberModels,
  providers: ReadonlyArray<ServerProvider>,
) => {
  const { checked, total } = crewMemberModelCounts(list, providers);
  return {
    label: `${checked} of ${total}`,
    nothingEligible: list !== null && total > 0 && checked === 0,
  };
};

/** The saved personas that run on a model the list leaves out, which they are free to do. */
export const personasOffCrewMemberModels = (
  catalog: OrchestrationV2AgentPersonaCatalog | null | undefined,
  list: CrewMemberModels,
): ReadonlyArray<string> =>
  (catalog?.personas ?? []).flatMap((persona) =>
    persona.availability.status === "available" &&
    !isCrewMemberModelChecked(list, persona.availability.resolvedModelSelection)
      ? [persona.displayName]
      : [],
  );

type LevelKey = Pick<CrewMemberReasoningLevel, "instanceId" | "level">;

const sameLevel = (left: LevelKey, right: LevelKey) =>
  left.instanceId === right.instanceId && left.level === right.level;

/** Every level of every provider a person can choose from, as checked pairs. */
const levelCatalogEntries = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<CrewMemberReasoningLevel> =>
  providers.filter(isCrewMemberProviderSetUp).flatMap((provider) =>
    crewMemberProviderLevels(provider).map(({ level }) => ({
      instanceId: provider.instanceId,
      level,
    })),
  );

/** The level list after one chip is changed, starting from the whole catalog when none was saved. */
export const setCrewMemberLevelChecked = (
  list: CrewMemberReasoning,
  providers: ReadonlyArray<ServerProvider>,
  key: LevelKey,
  checked: boolean,
): ReadonlyArray<CrewMemberReasoningLevel> => {
  const without = (list ?? levelCatalogEntries(providers)).filter(
    (entry) => !sameLevel(entry, key),
  );
  return checked ? [...without, { instanceId: key.instanceId, level: key.level }] : without;
};

/** The level list after every level of one provider is checked or unchecked. */
export const setCrewMemberProviderLevelsChecked = (
  list: CrewMemberReasoning,
  providers: ReadonlyArray<ServerProvider>,
  provider: ServerProvider,
  checked: boolean,
): ReadonlyArray<CrewMemberReasoningLevel> => {
  const others = (list ?? levelCatalogEntries(providers)).filter(
    (entry) => entry.instanceId !== provider.instanceId,
  );
  return checked
    ? [
        ...others,
        ...crewMemberProviderLevels(provider).map(({ level }) => ({
          instanceId: provider.instanceId,
          level,
        })),
      ]
    : others;
};

/** "3 of 4" levels, and whether a saved list leaves no level eligible. */
export const crewMemberLevelsSummary = (
  list: CrewMemberReasoning,
  providers: ReadonlyArray<ServerProvider>,
) => {
  const { checked, total } = crewMemberLevelCounts(list, providers);
  return {
    label: `${checked} of ${total}`,
    nothingEligible: list !== null && total > 0 && checked === 0,
  };
};

/** What one provider's card header says: "1 of 8 models", then its levels when it has any. */
export const crewMemberProviderSummary = (
  provider: ServerProvider,
  models: CrewMemberModels,
  reasoning: CrewMemberReasoning,
): string => {
  const modelCounts = crewMemberModelCounts(models, [provider]);
  const levelCounts = crewMemberLevelCounts(reasoning, [provider]);
  const modelsText = `${modelCounts.checked} of ${modelCounts.total} models`;
  return levelCounts.total === 0
    ? modelsText
    : `${modelsText} · ${levelCounts.checked} of ${levelCounts.total} levels`;
};

/**
 * The choices a seat's reasoning picker offers. A custom member's list narrows a select reasoning
 * option to the levels the project allows; pass `null` for a persona, whose picker stays whole.
 */
export const crewReasoningChoicesFor = (
  descriptor: ProviderOptionDescriptor | undefined,
  provider: Pick<ServerProvider, "instanceId"> | undefined,
  allowed: CrewMemberReasoning | undefined,
): ReadonlyArray<{ readonly id: string; readonly label: string }> => {
  if (descriptor === undefined) return [];
  if (descriptor.type === "boolean")
    return [
      { id: "true", label: "On" },
      { id: "false", label: "Off" },
    ];
  const isLevel =
    agentPersonaReasoningDescriptor({ capabilities: { optionDescriptors: [descriptor] } }) !==
    undefined;
  return !isLevel || provider === undefined
    ? descriptor.options
    : descriptor.options.filter((choice) =>
        isCrewMemberLevelChecked(allowed, { instanceId: provider.instanceId, level: choice.id }),
      );
};

/**
 * A custom member's seat after its model or provider changed: when the level it would run at is not
 * allowed, the first allowed level of that model is chosen, so the card never starts on a level the
 * server would refuse. A model with no allowed level is left as it is; approval refuses it.
 */
export const withEligibleCrewReasoning = <T extends { readonly modelSelection?: ModelSelection }>(
  draft: T,
  provider: Pick<ServerProvider, "instanceId" | "models">,
  model: ServerProviderModel,
  allowed: CrewMemberReasoning | undefined,
): T => {
  const descriptor = agentPersonaReasoningDescriptor(model);
  const selection = draft.modelSelection;
  if (descriptor === undefined || selection === undefined) return draft;
  const level = crewMemberSelectionLevel(model, selection.options);
  if (
    level === null ||
    isCrewMemberLevelChecked(allowed, { instanceId: provider.instanceId, level })
  )
    return draft;
  const first = eligibleCrewMemberLevelsForModel(allowed, provider, model.slug)[0];
  return first === undefined
    ? draft
    : { ...draft, modelSelection: setCrewReasoning(selection, descriptor, first.level) };
};
