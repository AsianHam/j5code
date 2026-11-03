import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewWorktreeCleanupAnswerRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  decidedWorktreeCleanupSourcesAtom,
  j5Environment,
  openWorktreeCleanupSourcesAtom,
  refreshJ5Sources,
  worktreeCleanupQueryAtom,
} from "../state";

/** Answer on the environment that holds the item; the refusal's message says why it failed. */
export async function answerCrewWorktreeCleanup(
  environmentId: EnvironmentId,
  input: CrewWorktreeCleanupAnswerRequest,
) {
  const result = await j5Environment.answerCrewWorktreeCleanup.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value.item;
}

/** Forced re-read after an answer or a refusal, so the item is as the server has it. */
export const refreshWorktreeCleanups = (environmentId?: EnvironmentId) => {
  const options = { force: true, ...(environmentId === undefined ? {} : { environmentId }) };
  return Promise.all([
    refreshJ5Sources(openWorktreeCleanupSourcesAtom, worktreeCleanupQueryAtom("open"), options),
    refreshJ5Sources(
      decidedWorktreeCleanupSourcesAtom,
      worktreeCleanupQueryAtom("decided"),
      options,
    ),
  ]).then((results) => results.flat());
};
