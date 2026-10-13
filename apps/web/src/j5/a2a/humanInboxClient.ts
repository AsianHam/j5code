import type { EnvironmentId } from "@t3tools/contracts";
import type { AnswerHumanExchangeRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type {
  HumanInboxItem,
  HumanInboxResponse,
  ScopedHumanInboxItem,
} from "@t3tools/contracts/j5";

export async function answerHumanExchange(
  environmentId: EnvironmentId,
  input: AnswerHumanExchangeRequest,
) {
  const result = await j5Environment.answerHumanExchange.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
