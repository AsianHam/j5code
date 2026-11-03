import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import {
  crewMemberModelRefusal,
  eligibleCrewMemberModels,
  isCrewMemberModelChecked,
} from "@t3tools/contracts/j5";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** A model outside the project's "Models for custom members" list, with what to use instead. */
export class CrewMemberModelNotEligibleError extends Schema.TaggedError<CrewMemberModelNotEligibleError>()(
  "CrewMemberModelNotEligibleError",
  {
    projectId: Schema.String,
    projectTitle: Schema.String,
    instanceId: Schema.String,
    model: Schema.String,
    eligible: Schema.Array(
      Schema.Struct({ instanceId: Schema.String, model: Schema.String, name: Schema.String }),
    ),
  },
) {
  override get message(): string {
    return crewMemberModelRefusal({
      selection: this,
      projectTitle: this.projectTitle,
      eligible: this.eligible,
    });
  }
}

/**
 * The one place that decides whether a resolved model may run a custom worker in a project: a
 * Crew's custom member, a plain `j5_spawn_agent`, or a plain `delegate_task`. Persona seats that
 * keep their persona's model never reach it.
 */
export class CrewMemberModels extends Context.Service<
  CrewMemberModels,
  {
    readonly assertEligible: (input: {
      readonly projectId: ProjectId;
      readonly selection: Pick<ModelSelection, "instanceId" | "model">;
    }) => Effect.Effect<void, CrewMemberModelNotEligibleError>;
  }
>()("t3/j5/agents/crewMemberModels") {}

export const layer = Layer.effect(
  CrewMemberModels,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry;
    const projects = yield* ProjectService;
    const assertEligible: CrewMemberModels["Service"]["assertEligible"] = Effect.fn(
      "j5.crewMemberModels.assertEligible",
    )(function* ({ projectId, selection }) {
      const list = yield* settings.getSettings.pipe(
        Effect.map((all) => resolveProjectSettings(all, projectId).settings.crewMemberModels),
        Effect.orDie,
      );
      if (isCrewMemberModelChecked(list, selection)) return;
      const eligible = eligibleCrewMemberModels(list, yield* registry.getProviders);
      const projectTitle = yield* projects.getById(projectId).pipe(
        Effect.map(Option.map((project) => project.title)),
        Effect.map(Option.getOrElse(() => projectId as string)),
        Effect.orElseSucceed(() => projectId as string),
      );
      return yield* new CrewMemberModelNotEligibleError({
        projectId,
        projectTitle,
        instanceId: selection.instanceId,
        model: selection.model,
        eligible,
      });
    });
    return CrewMemberModels.of({ assertEligible });
  }),
);
