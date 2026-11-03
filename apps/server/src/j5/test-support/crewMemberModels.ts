import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings_ from "../../serverSettings.ts";
import { CrewMemberModels, layer } from "../agents/crewMemberModels.ts";

/** For tests of other behavior: every model is eligible, as when no list was ever saved. */
export const permissiveCrewMemberModels = Layer.mock(CrewMemberModels)({
  assertEligible: () => Effect.void,
});

/**
 * The real eligibility service over test settings, providers and one project title, so a test
 * decides the list and watches the refusal.
 */
export const crewMemberModelsLayer = (input: {
  readonly settings?: Parameters<typeof ServerSettings_.layerTest>[0];
  /** The settings a test also changes through; the same layer object is built once per run. */
  readonly settingsLayer?: ReturnType<typeof ServerSettings_.layerTest>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectTitle?: string;
}) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        input.settingsLayer ?? ServerSettings_.layerTest(input.settings),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(input.providers) }),
        Layer.mock(ProjectService)({
          getById: (id) =>
            Effect.succeedSome({ id, title: input.projectTitle ?? "Test project" } as never),
        }),
      ),
    ),
    Layer.orDie,
  );
