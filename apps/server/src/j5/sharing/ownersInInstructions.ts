import { setServerOwners } from "@t3tools/provider-core/j5/orchestrationInstructions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import { Access } from "./Access.ts";
import { personNameInLine } from "./authorLabel.ts";

/**
 * Every agent's standing instructions name the server's Owners (Shared conversations AC9). The
 * names are set where the instructions are kept (`provider-core`'s J5 instructions, which
 * upstream's constant re-exports live), when the server starts and after each change of access,
 * so a session or turn that starts later reads the Owners as they are then. Pi bakes the
 * instructions into its extension when it is generated, and is not told.
 */
export const refreshOwnersInInstructions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const owners = yield* sql<{ readonly display_name: string }>`
    SELECT person.display_name
    FROM j5_a2a_human_person AS person
    JOIN j5_a2a_person_level AS held
      ON held.person_id = person.person_id
     AND held.scope_kind = 'server'
     AND held.level = 'owner'
    WHERE person.removed_at IS NULL AND person.display_name IS NOT NULL
    ORDER BY person.is_local_operator DESC, person.created_at, person.person_id
  `;
  const names = owners
    .map((owner) => personNameInLine(owner.display_name))
    .filter((name) => name.length > 0);
  yield* Effect.sync(() => setServerOwners(names));
}).pipe(
  Effect.catch((cause) =>
    Effect.logError("J5 could not name the server's Owners to its agents", { cause }),
  ),
  Effect.withSpan("j5.sharing.refreshOwnersInInstructions"),
);

export const ownersInInstructionsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    // Subscribed before the first read, so no change between the two is missed.
    const changes = yield* (yield* Access).subscribe;
    yield* refreshOwnersInInstructions;
    yield* Effect.forkScoped(
      Effect.forever(PubSub.take(changes).pipe(Effect.andThen(refreshOwnersInInstructions))),
    );
  }),
);
