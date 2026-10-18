import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import {
  J5ActionError,
  J5_CLIENT_ACTION_WS_METHODS,
  type AddPeerRequest,
  type AnswerHumanExchangeRequest,
  type CrewArchiveRequest,
  type CrewProposalPreviewRequest,
  type CrewProposalResolveRequest,
  type CrewRuntimeRequestRespondRequest,
  type CrewStopRequest,
  type IssuePeerCredentialRequest,
  type PeerProbeRequest,
  type RemovePeerRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { failAsJ5ActionError } from "../rpcActionError.ts";
import { connectionPersonId } from "../sharing/connectionPerson.ts";
import { requireOwner, requireReaches, requireWrites } from "../sharing/connectionWriter.ts";
import { PersonAccess, type SessionIdentity, reachPersonId } from "../sharing/PersonAccess.ts";
import { SharedConversation } from "../sharing/SharedConversation.ts";
import { SharedThreads } from "../sharing/SharedThreads.ts";
import { ClientActionsService } from "./ClientActionsService.ts";
import { crewCaptainThread } from "./crewCaptainThread.ts";
import { PeerAdminService, peerAdminRefusal } from "./PeerAdminService.ts";

const METHODS = J5_CLIENT_ACTION_WS_METHODS;

/**
 * Each method's scope, spread into upstream's table through `wsRpcScopes.ts`. Acting for the
 * person needs operate scope; the preview only reads; a peer is one more authorized session, so
 * peering carries the `access:write` scope Settings → Connections does.
 */
export const CLIENT_ACTION_RPC_SCOPES = {
  [METHODS.previewCrewProposal]: AuthOrchestrationReadScope,
  [METHODS.resolveCrewProposal]: AuthOrchestrationOperateScope,
  [METHODS.stopCrew]: AuthOrchestrationOperateScope,
  [METHODS.archiveCrew]: AuthOrchestrationOperateScope,
  [METHODS.respondCrewRuntimeRequest]: AuthOrchestrationOperateScope,
  [METHODS.answerHumanExchange]: AuthOrchestrationOperateScope,
  [METHODS.issuePeerCredential]: AuthAccessWriteScope,
  [METHODS.addPeer]: AuthAccessWriteScope,
  [METHODS.removePeer]: AuthAccessWriteScope,
  [METHODS.listPeerAddresses]: AuthAccessWriteScope,
  [METHODS.probePeer]: AuthAccessWriteScope,
} as const;

const proposalFailure = failAsJ5ActionError({
  refusals: [
    "CrewProposalNotFoundError",
    "CrewProposalNotOpenError",
    "CrewProposalRequestError",
    "CrewLaunchSeatUnavailableError",
    "CrewLaunchCapError",
    "CrewLaunchSeatConflictError",
    "CrewStepAlreadyOwnedError",
  ],
  failed: "Crew proposal operation failed.",
});

const peerFailure = (operation: string) => (error: Parameters<typeof peerAdminRefusal>[0]) => {
  const refusal = peerAdminRefusal(error);
  const failure = Effect.fail(new J5ActionError({ code: refusal.code, message: refusal.message }));
  return refusal.internal
    ? Effect.logError(`J5 A2A peer ${operation} failed`, { cause: error }).pipe(
        Effect.andThen(failure),
      )
    : failure;
};

/** Handlers for `J5ClientActionRpcGroup`: each calls one service method and maps its failure. */
export const makeClientActionRpcHandlers = Effect.fn("j5.makeClientActionRpcHandlers")(function* (
  session: SessionIdentity,
) {
  const actions = yield* ClientActionsService;
  const peers = yield* PeerAdminService;
  const people = yield* PersonAccess;
  const shared = yield* SharedThreads;
  const conversation = yield* SharedConversation;
  const sql = yield* SqlClient.SqlClient;
  // An answer is the connection's own person's, whatever the client sends.
  const personOf = connectionPersonId(session).pipe(Effect.provideService(PersonAccess, people));
  /**
   * A Crew's roster, its further seats and its stopping belong to everyone who can write to its
   * Captain's thread (Crews AC23); a seat's approval, to everyone who can write to the seat's.
   * A request naming nothing that exists goes on, and the action refuses it as not found.
   */
  const services = <A, E>(effect: Effect.Effect<A, E, PersonAccess | SharedThreads>) =>
    effect.pipe(
      Effect.provideService(PersonAccess, people),
      Effect.provideService(SharedThreads, shared),
    );
  const forCaptainOf = (target: Parameters<typeof crewCaptainThread>[1]) =>
    services(requireWrites(session, crewCaptainThread(sql, target)));
  // A Viewer reads a roster's prompt and how it was answered, with nothing to press (AC12).
  const readsCaptainOf = (target: Parameters<typeof crewCaptainThread>[1]) =>
    services(requireReaches(session, crewCaptainThread(sql, target)));
  return {
    [METHODS.previewCrewProposal]: (input: CrewProposalPreviewRequest) =>
      readsCaptainOf({ kind: "proposal", proposalId: input.proposalId }).pipe(
        Effect.andThen(actions.previewCrewProposal(input).pipe(Effect.catch(proposalFailure))),
      ),
    [METHODS.resolveCrewProposal]: (input: CrewProposalResolveRequest) =>
      forCaptainOf({ kind: "proposal", proposalId: input.proposalId }).pipe(
        Effect.andThen(people.sessionReach(session).pipe(Effect.orElseSucceed(() => null))),
        // In a shared conversation the Captain is told who decided (Shared conversations AC11).
        Effect.flatMap((reach) =>
          conversation.rosterDecider(
            reach === null ? null : reachPersonId(reach),
            input.proposalId,
          ),
        ),
        Effect.flatMap((decidedBy) =>
          actions.resolveCrewProposal(input, decidedBy).pipe(Effect.catch(proposalFailure)),
        ),
      ),
    [METHODS.stopCrew]: (input: CrewStopRequest) =>
      forCaptainOf({ kind: "crew", crewInstanceId: input.crewInstanceId })
        .pipe(Effect.andThen(actions.stopCrew(input)))
        .pipe(
          Effect.catch(
            failAsJ5ActionError({
              refusals: ["CrewStopNotFoundError", "CrewStopRequestError"],
              failed: "Stopping the crew failed.",
            }),
          ),
        ),
    [METHODS.archiveCrew]: (input: CrewArchiveRequest) =>
      services(requireOwner(session))
        .pipe(Effect.andThen(actions.archiveCrew(input)))
        .pipe(
          Effect.catch((error) =>
            error._tag === "ArchiveCrewPartialFailureError"
              ? failAsJ5ActionError({
                  refusals: [],
                  failed:
                    "Archiving the crew stopped partway; the seats already retired stay retired. Try again.",
                })(error)
              : failAsJ5ActionError({ failed: "Archiving the crew failed." })(error),
          ),
        ),
    [METHODS.respondCrewRuntimeRequest]: (input: CrewRuntimeRequestRespondRequest) =>
      // A seat's own prompt is answered by whoever writes to the seat's thread, which includes
      // everyone who writes to its Captain's.
      services(requireWrites(session, Effect.succeed(input.threadId)))
        .pipe(
          Effect.andThen(people.sessionReach(session).pipe(Effect.orElseSucceed(() => null))),
          Effect.flatMap((reach) => {
            const personId = reach === null ? null : reachPersonId(reach);
            return actions.respondCrewRuntimeRequest(
              input,
              personId === null
                ? undefined
                : (answer) => conversation.claimAnswer(personId, answer),
            );
          }),
        )
        .pipe(
          Effect.catch(
            failAsJ5ActionError({
              refusals: ["CrewRuntimeRequestNotFoundError", "CrewRuntimeRequestConflictError"],
              failed: "Answering the request failed.",
            }),
          ),
        ),
    [METHODS.answerHumanExchange]: (input: AnswerHumanExchangeRequest) =>
      personOf.pipe(
        Effect.flatMap((personId) =>
          actions
            .answerHumanExchange({ ...input, personId }, (reply) =>
              conversation.recordReply(personId, reply),
            )
            .pipe(Effect.catch(failAsJ5ActionError({ failed: "Human inbox operation failed." }))),
        ),
      ),
    [METHODS.issuePeerCredential]: (input: IssuePeerCredentialRequest) =>
      peers.issueCredential(input).pipe(Effect.catch(peerFailure("credential issuance"))),
    [METHODS.addPeer]: (input: AddPeerRequest) =>
      peers.add(input).pipe(Effect.catch(peerFailure("add"))),
    [METHODS.removePeer]: (input: RemovePeerRequest) =>
      peers.remove(input).pipe(Effect.catch(peerFailure("remove"))),
    [METHODS.listPeerAddresses]: () => peers.addresses,
    [METHODS.probePeer]: (input: PeerProbeRequest) => peers.probe(input),
  };
});
