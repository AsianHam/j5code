import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import type { ProviderOptionSelection } from "../model.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import type { ServerProvider, ServerProviderModel } from "../server.ts";
import { agentPersonaReasoningDescriptor } from "./agentPersona.ts";
import { CREW_MEMBER_MODELS_SETTING_LABEL, isCrewMemberProviderSetUp } from "./crewMemberModels.ts";

/** One checked reasoning level: the choice id of a model's reasoning option, per provider instance. */
export const CrewMemberReasoningLevel = Schema.Struct({
  instanceId: ProviderInstanceId,
  level: TrimmedNonEmptyString,
});
export type CrewMemberReasoningLevel = typeof CrewMemberReasoningLevel.Type;

/**
 * The reasoning levels custom Crew members and plain delegated or spawned agents may run at, with
 * the same semantics as `CrewMemberModels`: `null` means no list was ever saved and every level is
 * eligible, a saved list holds only the checked pairs, and an empty saved list makes none eligible.
 */
export const CrewMemberReasoning = Schema.NullOr(Schema.Array(CrewMemberReasoningLevel));
export type CrewMemberReasoning = typeof CrewMemberReasoning.Type;

type LevelKey = Pick<CrewMemberReasoningLevel, "instanceId" | "level">;

export interface CrewMemberLevel {
  readonly level: string;
  readonly label: string;
}

export interface CrewMemberLevelChoice extends CrewMemberLevel {
  readonly instanceId: ServerProvider["instanceId"];
}

const modelLevels = (
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
): ReadonlyArray<CrewMemberLevel> =>
  agentPersonaReasoningDescriptor(model)?.options.map((choice) => ({
    level: choice.id,
    label: choice.label,
  })) ?? [];

/**
 * A provider's levels: the choices of every model's reasoning option, each once, in order of first
 * appearance. Boolean options such as a thinking switch are not levels.
 */
export const crewMemberProviderLevels = (
  provider: Pick<ServerProvider, "models">,
): ReadonlyArray<CrewMemberLevel> => {
  const seen = new Map<string, CrewMemberLevel>();
  for (const model of provider.models)
    for (const level of modelLevels(model))
      if (!seen.has(level.level)) seen.set(level.level, level);
  return [...seen.values()];
};

export const isCrewMemberLevelChecked = (
  list: CrewMemberReasoning | undefined,
  key: LevelKey,
): boolean =>
  list === null ||
  list === undefined ||
  list.some((entry) => entry.instanceId === key.instanceId && entry.level === key.level);

/** The set-up providers' levels the list makes eligible, in provider order. Stale entries match nothing. */
export const eligibleCrewMemberLevels = (
  list: CrewMemberReasoning | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<CrewMemberLevelChoice> =>
  providers.filter(isCrewMemberProviderSetUp).flatMap((provider) =>
    crewMemberProviderLevels(provider)
      .filter((level) =>
        isCrewMemberLevelChecked(list, { instanceId: provider.instanceId, level: level.level }),
      )
      .map((level) => ({ instanceId: provider.instanceId, ...level })),
  );

/** "3 of 4": checked levels that are in the catalog, over the catalog. */
export const crewMemberLevelCounts = (
  list: CrewMemberReasoning | undefined,
  providers: ReadonlyArray<ServerProvider>,
): { readonly checked: number; readonly total: number } => ({
  checked: eligibleCrewMemberLevels(list, providers).length,
  total: providers
    .filter(isCrewMemberProviderSetUp)
    .reduce((count, provider) => count + crewMemberProviderLevels(provider).length, 0),
});

/** The levels one model offers that the list makes eligible, in the model's own order. */
export const eligibleCrewMemberLevelsForModel = (
  list: CrewMemberReasoning | undefined,
  provider: Pick<ServerProvider, "instanceId" | "models">,
  modelSlug: string,
): ReadonlyArray<CrewMemberLevel> =>
  modelLevels(provider.models.find((model) => model.slug === modelSlug)).filter((level) =>
    isCrewMemberLevelChecked(list, { instanceId: provider.instanceId, level: level.level }),
  );

/**
 * The level a selection runs at: its explicit reasoning value, or else the model's default for
 * that option. Null when the model has no reasoning option or the selection names no level and the
 * option has no default, so there is nothing to check.
 */
export const crewMemberSelectionLevel = (
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): string | null => {
  const descriptor = agentPersonaReasoningDescriptor(model);
  if (descriptor === undefined) return null;
  const explicit = options?.find((option) => option.id === descriptor.id)?.value;
  if (typeof explicit === "string") return explicit;
  return (
    descriptor.currentValue ?? descriptor.options.find((choice) => choice.isDefault)?.id ?? null
  );
};

const MAX_LISTED_LEVELS = 30;

/**
 * What a refused level tells the agent or the person: the level, the model and provider, the
 * project, the setting that decided it, and the levels that model can run at instead.
 */
export const crewMemberReasoningRefusal = (input: {
  readonly selection: {
    readonly instanceId: string;
    readonly model: string;
    readonly level: string;
  };
  readonly projectTitle: string;
  readonly eligible: ReadonlyArray<CrewMemberLevel>;
}): string => {
  const listed = input.eligible.slice(0, MAX_LISTED_LEVELS).map((choice) => choice.level);
  const more = input.eligible.length - listed.length;
  const alternatives =
    input.eligible.length === 0
      ? `No reasoning level of ${input.selection.model} is eligible: none is checked.`
      : `Eligible levels for ${input.selection.model}: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
  return `Reasoning level ${input.selection.level} of ${input.selection.model} on ${input.selection.instanceId} is not eligible for custom members in project "${input.projectTitle}". The project's list is the setting ${CREW_MEMBER_MODELS_SETTING_LABEL}. ${alternatives}`;
};
