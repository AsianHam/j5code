import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { Access } from "./Access.ts";
import { checkedPersonName } from "./personNames.ts";
import { PersonAccess } from "./PersonAccess.ts";

/**
 * Set by the dev runner (`scripts/lib/j5-dev-owner.ts`). Blank leaves the first owner unnamed,
 * which is how the live-test rig keeps the naming question testable.
 */
const DevOwnerName = Config.String("J5CODE_DEV_OWNER_NAME").pipe(Config.option);

/**
 * Names a development home's first owner at startup, if they have no name yet, so the first
 * browser to open it is not asked who they are (People and access AC6) on every fresh run. A name
 * already given is never replaced, and a name that cannot be used is logged and left out: this
 * is a convenience, and never keeps a dev server from starting.
 */
export const nameDevOwnerAtStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    // The variable reaches every process a dev server starts, a released server run from its
    // terminal included, so only a server running from the dev runner reads it.
    if ((yield* ServerConfig).devUrl === undefined) return;
    const configured = yield* DevOwnerName;
    if (Option.isNone(configured) || configured.value.trim() === "") return;
    const displayName = yield* checkedPersonName(configured.value);
    // The first owner may not be recorded yet: the runtime that records them can start after this.
    yield* SqlClient.SqlClient.use(ensureLocalOperatorHumanPerson);
    const owner = yield* PersonAccess.use((people) => people.firstOwner);
    if (owner.displayName !== null) return;
    yield* Access.use((access) => access.rename({ personId: owner.personId, displayName }));
    yield* Effect.logInfo("J5 named the development home's first owner", { displayName });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("J5 could not name the development home's first owner", { cause }),
    ),
  ),
);
