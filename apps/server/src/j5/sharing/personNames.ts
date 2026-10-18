import { isPersonName } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PersonNameError extends Schema.TaggedError<PersonNameError>()("PersonNameError", {}) {
  override get message(): string {
    return "A name is one line of ordinary, visible characters, up to 80 of them, with no square or angle brackets.";
  }
}

/**
 * A name as it is stored: trimmed, and refused unless it is one a person may have. Every way of
 * naming someone checks it here, the offline build of a live-test home included.
 */
export const checkedPersonName = (name: string): Effect.Effect<string, PersonNameError> => {
  const trimmed = name.trim();
  return isPersonName(trimmed) ? Effect.succeed(trimmed) : Effect.fail(new PersonNameError({}));
};
