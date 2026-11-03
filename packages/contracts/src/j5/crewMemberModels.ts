import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import type { ServerProvider, ServerProviderModel } from "../server.ts";

/** One checked model: the same `(instance, slug)` key the catalog and `ModelSelection` use. */
export const CrewMemberModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type CrewMemberModel = typeof CrewMemberModel.Type;

/**
 * The models custom Crew members and plain delegated or spawned agents may run on. `null` means
 * no list was ever saved and every model is eligible. A saved list holds only the checked pairs,
 * so a model new to the catalog is unchecked until someone checks it, and an empty saved list
 * makes no model eligible.
 */
export const CrewMemberModels = Schema.NullOr(Schema.Array(CrewMemberModel));
export type CrewMemberModels = typeof CrewMemberModels.Type;

export const CREW_MEMBER_MODELS_SETTING_LABEL = "Models for custom members in Agent Setup";

type ModelKey = Pick<CrewMemberModel, "instanceId" | "model">;

/**
 * A provider whose models a person can choose from: the same test the roster card's provider
 * picker applies, so the setting and the picker offer the same catalog.
 */
export const isCrewMemberProviderSetUp = (
  provider: Pick<ServerProvider, "enabled" | "installed" | "status" | "availability" | "models">,
): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  provider.availability !== "unavailable" &&
  provider.models.length > 0;

export const isCrewMemberModelChecked = (
  list: CrewMemberModels | undefined,
  selection: ModelKey,
): boolean =>
  list === null ||
  list === undefined ||
  list.some(
    (entry) => entry.instanceId === selection.instanceId && entry.model === selection.model,
  );

export interface CrewMemberModelChoice {
  readonly instanceId: ServerProvider["instanceId"];
  readonly model: ServerProviderModel["slug"];
  readonly name: string;
}

/** The catalog models the list makes eligible, in provider order. Stale entries match nothing. */
export const eligibleCrewMemberModels = (
  list: CrewMemberModels | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<CrewMemberModelChoice> =>
  providers.filter(isCrewMemberProviderSetUp).flatMap((provider) =>
    provider.models
      .filter((model) =>
        isCrewMemberModelChecked(list, { instanceId: provider.instanceId, model: model.slug }),
      )
      .map((model) => ({
        instanceId: provider.instanceId,
        model: model.slug,
        name: model.name,
      })),
  );

/** "6 of 12": checked models that are in the catalog, over the catalog. */
export const crewMemberModelCounts = (
  list: CrewMemberModels | undefined,
  providers: ReadonlyArray<ServerProvider>,
): { readonly checked: number; readonly total: number } => ({
  checked: eligibleCrewMemberModels(list, providers).length,
  total: providers
    .filter(isCrewMemberProviderSetUp)
    .reduce((count, provider) => count + provider.models.length, 0),
});

const MAX_LISTED_MODELS = 30;

/**
 * What a refused model tells the agent or the person: the model, the project, the setting that
 * decided it, and the models they can use instead.
 */
export const crewMemberModelRefusal = (input: {
  readonly selection: { readonly instanceId: string; readonly model: string };
  readonly projectTitle: string;
  readonly eligible: ReadonlyArray<{ readonly instanceId: string; readonly model: string }>;
}): string => {
  const listed = input.eligible
    .slice(0, MAX_LISTED_MODELS)
    .map((choice) => `${choice.instanceId}/${choice.model}`);
  const more = input.eligible.length - listed.length;
  const alternatives =
    input.eligible.length === 0
      ? "No model is eligible: nothing is checked."
      : `Eligible models: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
  return `Model ${input.selection.model} on ${input.selection.instanceId} is not eligible for custom members in project "${input.projectTitle}". The project's list is the setting ${CREW_MEMBER_MODELS_SETTING_LABEL}. ${alternatives}`;
};
