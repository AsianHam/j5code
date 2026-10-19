import { AuthAccessReadScope, AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import {
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
import { connectionPersonId } from "../sharing/connectionPerson.ts";
import { connectionReads, connectionWrites } from "../sharing/connectionWriter.ts";
import { PersonAccess, type SessionIdentity } from "../sharing/PersonAccess.ts";
import { SharedThreads } from "../sharing/SharedThreads.ts";
import { ClientReadsService } from "./ClientReadsService.ts";
import { ParticipantId } from "./contracts.ts";
import { PeerAdminService } from "./PeerAdminService.ts";
import { ReadChanges } from "./ReadChanges.ts";

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
  [METHODS.subscribeReadChanges]: AuthOrchestrationReadScope,
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

/** An id that is not one names nobody, so it stays unknown rather than failing the ids beside it. */
const isParticipantId = Schema.is(ParticipantId);

/** Handlers for `J5ClientReadRpcGroup`: each calls one service method and maps its failure. */
export const makeClientReadRpcHandlers = Effect.fn("j5.makeClientReadRpcHandlers")(function* (
  session: SessionIdentity,
) {
  const clientReads = yield* ClientReadsService;
  const peers = yield* PeerAdminService;
  const changes = yield* ReadChanges;
  const people = yield* PersonAccess;
  const shared = yield* SharedThreads;
  // The inbox is the connection's own person's, whatever the client asks.
  const personOf = connectionPersonId(session).pipe(Effect.provideService(PersonAccess, people));
  // A Crew's requests are listed to whoever can write to its Captain's thread (Crews AC23).
  const writes = connectionWrites(session).pipe(
    Effect.provideService(PersonAccess, people),
    Effect.provideService(SharedThreads, shared),
  );
  const reaches = connectionReads(session).pipe(
    Effect.provideService(PersonAccess, people),
    Effect.provideService(SharedThreads, shared),
  );
  return {
    [METHODS.listHumanInbox]: (input: HumanInboxListRequest) =>
      personOf.pipe(
        Effect.flatMap((personId) =>
          clientReads
            .humanInbox({ status: input.status, personId })
            .pipe(Effect.catch(inboxFailure)),
        ),
      ),
    [METHODS.readOpenInboxCount]: (_input: OpenInboxCountRequest) =>
      personOf.pipe(
        Effect.flatMap((personId) =>
          clientReads.openInboxCount(personId).pipe(Effect.catch(inboxFailure)),
        ),
      ),
    [METHODS.listCrewProposals]: () =>
      Effect.gen(function* () {
        const listed = yield* clientReads.crewProposals.pipe(
          Effect.catch(failed("Reading crew proposals failed.")),
        );
        // Listed to whoever reaches the Captain: a Viewer sees a roster's prompt and how it was
        // answered, with nothing to press (Shared conversations AC11).
        const reachesCaptain = yield* reaches;
        return {
          proposals: yield* Effect.filter(listed.proposals, (proposal) =>
            reachesCaptain(Effect.succeed(ThreadId.make(proposal.captainThreadId))),
          ),
        };
      }),
    [METHODS.listCrewRuntimeRequests]: () =>
      Effect.gen(function* () {
        const listed = yield* clientReads.crewRuntimeRequests.pipe(
          Effect.catch(failed("Reading crew requests failed.")),
        );
        const mayAnswer = yield* writes;
        return {
          // A seat's approval is the seat's own prompt: whoever writes to the seat's thread
          // answers it, everyone who writes to its Captain's included.
          requests: yield* Effect.filter(listed.requests, (request) =>
            mayAnswer(Effect.succeed(request.threadId)),
          ),
        };
      }),
    [METHODS.listCrewMemberships]: (input: ThreadHomesRequest) =>
      Effect.gen(function* () {
        // A narrowed person is told the Crews of the threads they reach, and no others.
        const reachesThread = yield* reaches;
        const threadIds = yield* Effect.filter(input.threadIds, (threadId) =>
          reachesThread(Effect.succeed(threadId)),
        );
        return yield* clientReads
          .crewMemberships(threadIds)
          .pipe(Effect.catch(failed("Crew membership read failed.")));
      }),
    [METHODS.readFleet]: (input: FleetReadRequest) =>
      clientReads
        .fleet(input.includeRetired === true)
        .pipe(Effect.catch(failed("Fleet read failed."))),
    [METHODS.listSpawnedChildren]: (input: ThreadHomesRequest) =>
      clientReads
        .spawnedChildren(input.threadIds)
        .pipe(Effect.catch(failed("Spawned children read failed."))),
    [METHODS.readPreArchiveFacts]: (input: PreArchiveFactsRequest) =>
      clientReads
        .preArchiveFacts(input.threadId)
        .pipe(Effect.catch(failed("Pre-archive fact lookup failed."))),
    [METHODS.readParticipantIdentities]: (input: ParticipantIdentitiesRequest) =>
      clientReads
        .participantIdentities({ participantIds: input.participantIds.filter(isParticipantId) })
        .pipe(Effect.catch(failed("Client read failed."))),
    [METHODS.listPeers]: () => peers.list.pipe(Effect.catch(failed("Listing peers failed."))),
    [METHODS.subscribeReadChanges]: () => changes.changes,
  };
});
