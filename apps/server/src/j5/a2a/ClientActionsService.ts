import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId } from "@t3tools/contracts";
import type {
  AnswerHumanExchangeRequest,
  AnswerHumanExchangeResponse,
  CrewArchiveRequest,
  CrewArchiveResponse,
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
  CrewProposalResolveRequest,
  CrewProposalResolveResponse,
  CrewRuntimeRequestRespondRequest,
  CrewRuntimeRequestRespondResponse,
  CrewStopRequest,
  CrewStopResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { CommCommandId, ExchangeId, ParticipantId } from "./contracts.ts";
import { projectCrewProposal } from "./crewProposalProjection.ts";
import { CrewProposalService } from "./CrewProposalService.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";
import { CrewStopService } from "./CrewStopService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";

const HUMAN_STOP_SESSION = "j5-crew-stop-human";
const HUMAN_ARCHIVE_SESSION = "j5-crew-archive-human";

type Failure<Method> = Method extends (...args: never) => Effect.Effect<unknown, infer E>
  ? E
  : never;

/**
 * What a person does from a client, beside `ClientReadsService`. The person is not a Crew
 * participant: there is no Captain check, each act is keyed by a fresh request id, and the Crew
 * and Exchange services underneath do the work. Failures are theirs, unchanged.
 */
export class ClientActionsService extends Context.Service<
  ClientActionsService,
  {
    /** Resolve the runtime settings the roster card shows, and the token an approval must carry. */
    readonly previewCrewProposal: (
      input: CrewProposalPreviewRequest,
      options?: { readonly forGuest?: boolean },
    ) => Effect.Effect<
      CrewProposalPreviewResponse,
      Failure<CrewProposalService["Service"]["preview"]>
    >;
    /** Approve (with the final seats) or decline one proposal; answers with it as the card reads it. */
    readonly resolveCrewProposal: (
      input: CrewProposalResolveRequest,
      /** Who is answering, as the Captain is told; given only for a shared conversation. */
      decidedBy?: string | null,
    ) => Effect.Effect<
      typeof CrewProposalResolveResponse.Type,
      Failure<CrewProposalService["Service"]["resolve"]>
    >;
    /** Interrupt every running seat; nothing is retired. Each call is one stop. */
    readonly stopCrew: (
      input: CrewStopRequest,
    ) => Effect.Effect<CrewStopResponse, Failure<CrewStopService["Service"]["stop"]>>;
    /**
     * Retire a Crew as a unit. The dialog the person confirmed already listed every seat's open
     * asks and running turns, so the archive runs with its confirmation satisfied; seats that
     * already retired replay as already archived.
     */
    readonly archiveCrew: (
      input: CrewArchiveRequest,
    ) => Effect.Effect<CrewArchiveResponse, Failure<ArchiveCrewService["Service"]["archive"]>>;
    /** Answer a seat's provider approval from the Inbox; refused once the request resolved. */
    readonly respondCrewRuntimeRequest: (
      input: CrewRuntimeRequestRespondRequest,
    ) => Effect.Effect<
      CrewRuntimeRequestRespondResponse,
      Failure<CrewRuntimeRequestService["Service"]["respond"]>
    >;
    /** Answer an Exchange an agent opened with the person, then wake delivery. */
    readonly answerHumanExchange: (
      input: AnswerHumanExchangeRequest,
    ) => Effect.Effect<
      typeof AnswerHumanExchangeResponse.Type,
      Failure<A2AHumanInbox["Service"]["answer"]>
    >;
  }
>()("t3/j5/a2a/ClientActionsService") {}

/** A seat whose thread never came to exist has no result a client knows. */
const createdSeats = <Result extends string>(
  members: ReadonlyArray<{
    readonly seatName: string;
    readonly participantId: string;
    readonly result: Result | "never_created";
  }>,
) =>
  members.flatMap((member) =>
    member.result === "never_created"
      ? []
      : [{ seat: member.seatName, participantId: member.participantId, result: member.result }],
  );

const make = Effect.gen(function* () {
  const proposals = yield* CrewProposalService;
  const stops = yield* CrewStopService;
  const archives = yield* ArchiveCrewService;
  const runtimeRequests = yield* CrewRuntimeRequestService;
  const inbox = yield* A2AHumanInbox;
  const worker = yield* A2ADeliveryWorker;
  // A random source that fails is the host's fault, not a refusal a client can act on.
  const freshId = (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);
  const projectProposal = projectCrewProposal(yield* PlaybookStore);

  return ClientActionsService.of({
    previewCrewProposal: (input, options) => proposals.preview(input, options),
    resolveCrewProposal: (input, decidedBy) =>
      proposals.resolve({ ...input, decidedBy }).pipe(
        Effect.flatMap((result) =>
          projectProposal(result.proposal).pipe(
            Effect.map((proposal) => ({
              proposal,
              crewInstanceId: result.instance?.id ?? null,
            })),
          ),
        ),
      ),
    stopCrew: ({ crewInstanceId }) =>
      Effect.gen(function* () {
        const requestKey = yield* freshId;
        return yield* stops.stop({
          callerParticipantId: null,
          projectId: null,
          crewInstanceId,
          commandIds: (seatName) => ({
            interruptCommandId: CommandId.make(
              lifecycleCommandId({
                providerSessionId: HUMAN_STOP_SESSION,
                requestKey: crewSeatRequestKey(requestKey, seatName),
                operation: "stop-crew-interrupt",
              }),
            ),
          }),
        });
      }).pipe(
        Effect.map((result) => ({
          crewInstanceId: result.crewInstanceId,
          members: createdSeats(result.members),
        })),
      ),
    archiveCrew: ({ crewInstanceId }) =>
      Effect.gen(function* () {
        const requestKey = yield* freshId;
        const archivedAt = DateTime.formatIso(yield* DateTime.now);
        const result = yield* archives.archive({
          providerSessionId: HUMAN_ARCHIVE_SESSION,
          callerParticipantId: null,
          projectId: null,
          crewInstanceId,
          clientRequestKey: requestKey,
          confirmationSatisfied: true,
          archivedAt,
          commandIds: (seatName) => ({
            interruptCommandId: lifecycleCommandId({
              providerSessionId: HUMAN_ARCHIVE_SESSION,
              requestKey: crewSeatRequestKey(requestKey, seatName),
              operation: "archive-crew-interrupt",
            }),
            archiveCommandId: lifecycleCommandId({
              providerSessionId: HUMAN_ARCHIVE_SESSION,
              requestKey: crewSeatRequestKey(requestKey, seatName),
              operation: "archive-crew-thread",
            }),
          }),
        });
        return { crewInstanceId, status: result.status, members: createdSeats(result.members) };
      }),
    respondCrewRuntimeRequest: ({ threadId, requestId, decision }) =>
      freshId.pipe(
        Effect.flatMap((id) =>
          runtimeRequests.respond({
            threadId,
            requestId,
            decision,
            // Fresh per answer, so a second answer is refused by the request's state.
            commandId: CommandId.make(`j5-crew-runtime-request:${id}`),
          }),
        ),
        Effect.as({ threadId, requestId }),
      ),
    answerHumanExchange: (input) =>
      Effect.gen(function* () {
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        const result = yield* inbox.answer({
          commandId: CommCommandId.make(
            `command:j5:a2a:human:${encodeURIComponent(input.personId)}:${encodeURIComponent(input.exchangeId)}:${encodeURIComponent(input.clientRequestId)}`,
          ),
          personId: ParticipantId.make(input.personId),
          exchangeId: ExchangeId.make(input.exchangeId),
          message: input.message,
          acceptedAt,
        });
        yield* worker.notify;
        return { result };
      }),
  });
});

// The runtime layer carries no Crypto of its own; the service brings the Node one along.
export const layer = Layer.effect(ClientActionsService, make).pipe(Layer.provide(NodeCrypto.layer));
