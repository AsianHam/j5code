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

import { failAsJ5ActionError } from "../rpcActionError.ts";
import { ClientActionsService } from "./ClientActionsService.ts";
import { proposalForGuest } from "./CrewProposalService.ts";
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
export const makeClientActionRpcHandlers = Effect.fn("j5.makeClientActionRpcHandlers")(
  function* (options?: {
    /**
     * Names the person on this connection when the proposal's Captain is in a shared
     * conversation, where the Captain is told who answered; `null` anywhere else.
     */
    readonly rosterDecider: (proposalId: string) => Effect.Effect<string | null>;
    /** The connection is a guest's: a roster is shown without the host's folders and branches. */
    readonly forGuest?: boolean;
  }) {
    const actions = yield* ClientActionsService;
    const peers = yield* PeerAdminService;
    return {
      [METHODS.previewCrewProposal]: (input: CrewProposalPreviewRequest) =>
        actions
          .previewCrewProposal(input, { forGuest: options?.forGuest === true })
          .pipe(Effect.catch(proposalFailure)),
      [METHODS.resolveCrewProposal]: (input: CrewProposalResolveRequest) =>
        (options?.rosterDecider(input.proposalId) ?? Effect.succeed(null)).pipe(
          Effect.flatMap((decidedBy) => actions.resolveCrewProposal(input, decidedBy)),
          Effect.map((result) =>
            options?.forGuest === true
              ? { ...result, proposal: proposalForGuest(result.proposal) }
              : result,
          ),
          Effect.catch(proposalFailure),
        ),
      [METHODS.stopCrew]: (input: CrewStopRequest) =>
        actions.stopCrew(input).pipe(
          Effect.catch(
            failAsJ5ActionError({
              refusals: ["CrewStopNotFoundError", "CrewStopRequestError"],
              failed: "Stopping the crew failed.",
            }),
          ),
        ),
      [METHODS.archiveCrew]: (input: CrewArchiveRequest) =>
        actions.archiveCrew(input).pipe(
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
        actions.respondCrewRuntimeRequest(input).pipe(
          Effect.catch(
            failAsJ5ActionError({
              refusals: ["CrewRuntimeRequestNotFoundError", "CrewRuntimeRequestConflictError"],
              failed: "Answering the request failed.",
            }),
          ),
        ),
      [METHODS.answerHumanExchange]: (input: AnswerHumanExchangeRequest) =>
        actions
          .answerHumanExchange(input)
          .pipe(Effect.catch(failAsJ5ActionError({ failed: "Human inbox operation failed." }))),
      [METHODS.issuePeerCredential]: (input: IssuePeerCredentialRequest) =>
        peers.issueCredential(input).pipe(Effect.catch(peerFailure("credential issuance"))),
      [METHODS.addPeer]: (input: AddPeerRequest) =>
        peers.add(input).pipe(Effect.catch(peerFailure("add"))),
      [METHODS.removePeer]: (input: RemovePeerRequest) =>
        peers.remove(input).pipe(Effect.catch(peerFailure("remove"))),
      [METHODS.listPeerAddresses]: () => peers.addresses,
      [METHODS.probePeer]: (input: PeerProbeRequest) => peers.probe(input),
    };
  },
);
