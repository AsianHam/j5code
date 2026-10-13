import { AuthAccessReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5ActionError,
  J5_CLIENT_READ_WS_METHODS,
  type FleetReadRequest,
  type HumanInboxListRequest,
  type OpenInboxCountRequest,
  type ParticipantIdentitiesRequest,
  type PreArchiveFactsRequest,
  type ThreadHomesRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { failAsJ5ActionError } from "../rpcActionError.ts";
import { ClientReadsService } from "./ClientReadsService.ts";
import { ParticipantId } from "./contracts.ts";
import { PeerAdminService } from "./PeerAdminService.ts";

const METHODS = J5_CLIENT_READ_WS_METHODS;

/**
 * Each method's scope, spread into upstream's table through `wsRpcScopes.ts`. Reading the ledger
 * needs read scope; the peer list carries the `access:read` scope Settings → Connections does.
 */
export const CLIENT_READ_RPC_SCOPES = {
  [METHODS.listHumanInbox]: AuthOrchestrationReadScope,
  [METHODS.readOpenInboxCount]: AuthOrchestrationReadScope,
  [METHODS.listCrewProposals]: AuthOrchestrationReadScope,
  [METHODS.listCrewRuntimeRequests]: AuthOrchestrationReadScope,
  [METHODS.listCrewMemberships]: AuthOrchestrationReadScope,
  [METHODS.readFleet]: AuthOrchestrationReadScope,
  [METHODS.listSpawnedChildren]: AuthOrchestrationReadScope,
  [METHODS.readPreArchiveFacts]: AuthOrchestrationReadScope,
  [METHODS.readParticipantIdentities]: AuthOrchestrationReadScope,
  [METHODS.listPeers]: AuthAccessReadScope,
} as const;

/** A person the request names who is not one of this server's people is a refusal, not a fault. */
const inboxFailure = failAsJ5ActionError({
  refusals: [
    "A2AHumanPersonIdError",
    "A2AParticipantNotFoundError",
    "A2ALocalOperatorNotFoundError",
  ],
  failed: "Reading the Inbox failed.",
});

const failed = (message: string) => failAsJ5ActionError({ refusals: [], failed: message });

const decodeParticipantIds = Schema.decodeUnknownEffect(Schema.Array(ParticipantId));
/** The wire carries participant ids as plain strings; one that is not an id is the caller's mistake. */
const participantIds = (ids: ReadonlyArray<string>) =>
  decodeParticipantIds(ids).pipe(
    Effect.mapError(
      () => new J5ActionError({ code: "invalid_request", message: "A participant id is invalid." }),
    ),
  );
const optionalPerson = (personId: string | undefined) =>
  personId === undefined || personId.length === 0
    ? Effect.succeed(undefined)
    : participantIds([personId]).pipe(Effect.map(([id]) => id));

/** Handlers for `J5ClientReadRpcGroup`: each calls one service method and maps its failure. */
export const makeClientReadRpcHandlers = Effect.fn("j5.makeClientReadRpcHandlers")(function* () {
  const reads = yield* ClientReadsService;
  const peers = yield* PeerAdminService;
  return {
    [METHODS.listHumanInbox]: (input: HumanInboxListRequest) =>
      optionalPerson(input.personId).pipe(
        Effect.flatMap((personId) =>
          reads
            .humanInbox({ status: input.status, ...(personId === undefined ? {} : { personId }) })
            .pipe(Effect.catch(inboxFailure)),
        ),
      ),
    [METHODS.readOpenInboxCount]: (input: OpenInboxCountRequest) =>
      optionalPerson(input.personId).pipe(
        Effect.flatMap((personId) =>
          reads.openInboxCount(personId).pipe(Effect.catch(inboxFailure)),
        ),
      ),
    [METHODS.listCrewProposals]: () =>
      reads.crewProposals.pipe(Effect.catch(failed("Reading crew proposals failed."))),
    [METHODS.listCrewRuntimeRequests]: () =>
      reads.crewRuntimeRequests.pipe(Effect.catch(failed("Reading crew requests failed."))),
    [METHODS.listCrewMemberships]: (input: ThreadHomesRequest) =>
      reads
        .crewMemberships(input.threadIds)
        .pipe(Effect.catch(failed("Crew membership read failed."))),
    [METHODS.readFleet]: (input: FleetReadRequest) =>
      reads.fleet(input.includeRetired === true).pipe(Effect.catch(failed("Fleet read failed."))),
    [METHODS.listSpawnedChildren]: (input: ThreadHomesRequest) =>
      reads
        .spawnedChildren(input.threadIds)
        .pipe(Effect.catch(failed("Spawned children read failed."))),
    [METHODS.readPreArchiveFacts]: (input: PreArchiveFactsRequest) =>
      reads
        .preArchiveFacts(input.threadId)
        .pipe(Effect.catch(failed("Pre-archive fact lookup failed."))),
    [METHODS.readParticipantIdentities]: (input: ParticipantIdentitiesRequest) =>
      participantIds(input.participantIds).pipe(
        Effect.flatMap((ids) =>
          reads
            .participantIdentities({ participantIds: ids })
            .pipe(Effect.catch(failed("Client read failed."))),
        ),
      ),
    [METHODS.listPeers]: () => peers.list.pipe(Effect.catch(failed("Listing peers failed."))),
  };
});
