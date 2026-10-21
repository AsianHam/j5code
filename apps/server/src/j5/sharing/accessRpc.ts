import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  type ClaimDeviceRequest,
  type ConnectionAccess,
  type FirstOwnerNameRequest,
  J5_ACCESS_WS_METHODS,
  type LeaveScopeRequest,
  type ThreadLevelRequest,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ParticipantId } from "../a2a/contracts.ts";
import { failAsJ5ActionError } from "../rpcActionError.ts";
import type { Access } from "./Access.ts";
import { type PersonAccess, type SessionIdentity, isWide } from "./PersonAccess.ts";

/**
 * Every request here needs only what every paired device holds: each answers for the connection's
 * own session, and a device the server cannot place asks them to say whose it is.
 */
export const ACCESS_RPC_SCOPES = {
  [J5_ACCESS_WS_METHODS.getConnectionAccess]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.subscribeThreadLevel]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.listClaimablePeople]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.claimDevice]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.setFirstOwnerName]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.leave]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.markRetiredLinksSeen]: AuthOrchestrationReadScope,
} as const;

/** How long after the move to levels an Owner is told that old links stopped working. */
const RETIRED_LINKS_NOTICE = Duration.days(30);

const refused = failAsJ5ActionError({
  refusals: [
    "PersonNotFoundError",
    "PersonNameTakenError",
    "FirstOwnerFixedError",
    "NotYoursToLeaveError",
    "DeviceAlreadyClaimedError",
    "NotTheFirstOwnerError",
    "AccessRenewalError",
  ],
  failed: "Your access could not be read or changed.",
});

class NotTheFirstOwnerError extends Schema.TaggedError<NotTheFirstOwnerError>()(
  "NotTheFirstOwnerError",
  {},
) {
  override get message(): string {
    return "Only the server's first owner names themselves here.";
  }
}

export const makeAccessRpcHandlers = (options: {
  readonly people: PersonAccess["Service"];
  readonly access: Access["Service"];
  readonly session: SessionIdentity & { readonly scopes: ReadonlyArray<string> };
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { people, access, session } = options;

    // Shown to each Owner until they have seen it, for as long as one of the old links could
    // still have been sent around.
    const retiredLinks = (personId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly count: number; readonly created_at: string }>`
        SELECT notice.count, notice.created_at FROM j5_a2a_sharing_notice AS notice
        WHERE notice.kind = 'links_retired' AND NOT EXISTS (
          SELECT 1 FROM j5_a2a_sharing_notice_seen AS seen
          WHERE seen.kind = notice.kind AND seen.person_id = ${personId}
        )
      `;
        const row = rows[0];
        if (row === undefined) return null;
        const until = DateTime.addDuration(
          DateTime.makeUnsafe(row.created_at),
          RETIRED_LINKS_NOTICE,
        );
        return DateTime.isLessThan(yield* DateTime.now, until) ? row.count : null;
      });

    const connectionAccess = Effect.gen(function* () {
      const reach = yield* people.sessionReach(session);
      if (reach.kind !== "person") return { kind: reach.kind } satisfies ConnectionAccess;
      const owner = levelReaches(reach.serverLevel, "owner");
      return {
        kind: "person",
        personId: reach.person.personId,
        name: reach.person.displayName,
        firstOwner: reach.person.firstOwner,
        levels: reach.levels,
        wide: isWide(reach),
        owner,
        retiredLinks: owner ? yield* retiredLinks(reach.person.personId) : null,
      } satisfies ConnectionAccess;
    });

    return {
      [J5_ACCESS_WS_METHODS.getConnectionAccess]: () =>
        connectionAccess.pipe(Effect.catch(refused)),

      [J5_ACCESS_WS_METHODS.subscribeThreadLevel]: (input: ThreadLevelRequest) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribed before the first read, so no change between the two is missed.
            const changes = yield* people.subscribeChanges;
            const read = people.sessionReach(session).pipe(
              Effect.flatMap((reach) =>
                reach.kind === "service"
                  ? Effect.succeed("owner" as const)
                  : reach.kind === "unknown"
                    ? Effect.succeed(null)
                    : people.threadLevel(reach.person.personId, input.threadId),
              ),
              Effect.map((level) => ({ level })),
            );
            return Stream.fromEffect(read).pipe(
              Stream.concat(Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => read))),
              Stream.changesWith((a, b) => a.level === b.level),
            );
          }),
        ).pipe(Stream.catch((cause) => Stream.fromEffect(refused(cause)))),

      [J5_ACCESS_WS_METHODS.listClaimablePeople]: () =>
        Effect.gen(function* () {
          const reach = yield* people.sessionReach(session);
          // Asked only by a device that is no one's yet; anyone else is told no one.
          if (reach.kind !== "unknown") return { people: [] };
          const everyone = yield* people.listPeople;
          return {
            people: everyone.flatMap((record) =>
              record.person.displayName === null
                ? []
                : [
                    {
                      personId: record.person.personId,
                      name: record.person.displayName,
                      levels: record.levels,
                    },
                  ],
            ),
          };
        }).pipe(Effect.catch(refused)),

      [J5_ACCESS_WS_METHODS.claimDevice]: (input: ClaimDeviceRequest) =>
        access
          .claimDevice(
            session,
            input.kind === "person"
              ? { kind: "person", personId: ParticipantId.make(input.personId) }
              : { kind: "new", displayName: input.name },
          )
          .pipe(Effect.as({}), Effect.catch(refused)),

      [J5_ACCESS_WS_METHODS.setFirstOwnerName]: (input: FirstOwnerNameRequest) =>
        Effect.gen(function* () {
          const reach = yield* people.sessionReach(session);
          if (reach.kind !== "person" || !reach.person.firstOwner) {
            return yield* new NotTheFirstOwnerError({});
          }
          yield* access.rename({ personId: reach.person.personId, displayName: input.name });
          return {};
        }).pipe(Effect.catch(refused)),

      [J5_ACCESS_WS_METHODS.leave]: (input: LeaveScopeRequest) =>
        access.leave(session, input.scope).pipe(Effect.as({}), Effect.catch(refused)),

      [J5_ACCESS_WS_METHODS.markRetiredLinksSeen]: () =>
        Effect.gen(function* () {
          const reach = yield* people.sessionReach(session);
          if (reach.kind !== "person") return {};
          const seenAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT OR IGNORE INTO j5_a2a_sharing_notice_seen (kind, person_id, seen_at)
            VALUES ('links_retired', ${reach.person.personId}, ${seenAt})
          `;
          return {};
        }).pipe(Effect.catch(refused)),
    };
  });
