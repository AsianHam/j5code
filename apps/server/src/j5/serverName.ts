import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The name a person gave this server with `J5CODE_SERVER_NAME`, or null when the variable is
 * unset. `resolveServerEnvironmentLabel` reads it before the host's own names, so two servers on
 * one machine can be told apart. The caller trims it and treats a blank value as unset.
 */
export const configuredServerName = Config.String("J5CODE_SERVER_NAME").pipe(
  Config.option,
  Config.map(Option.getOrNull),
  Effect.orElseSucceed(() => null),
);
