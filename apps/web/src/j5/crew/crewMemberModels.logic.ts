import type { OrchestrationV2AgentPersonaCatalog, ServerProvider } from "@t3tools/contracts";
import {
  crewMemberModelCounts,
  isCrewMemberModelChecked,
  isCrewMemberProviderSetUp,
  type CrewMemberModel,
  type CrewMemberModels,
} from "@t3tools/contracts/j5";

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
