import { J5ActionError } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { PersonAccess, type SessionIdentity } from "./PersonAccess.ts";

/**
 * The person a connection is, for a request about that person's own things, such as their inbox:
 * read from the session the socket was opened with, never from what the client sends. A session
 * that is no person's is refused.
 */
export const connectionPersonId = (session: SessionIdentity) =>
  PersonAccess.use((people) => people.sessionReach(session)).pipe(
    Effect.mapError(
      () => new J5ActionError({ code: "storage", message: "Could not read whose this device is." }),
    ),
    Effect.flatMap((reach) =>
      reach.kind === "person"
        ? Effect.succeed(reach.person.personId)
        : Effect.fail(
            new J5ActionError({
              code: "NoPerson",
              message: "This device is no one's on this server, so it has no inbox here.",
            }),
          ),
    ),
  );
