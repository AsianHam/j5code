import * as NodeServices from "@effect/platform-node/NodeServices";
import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import type { CrewProposal } from "./AgentCrewProposalService.ts";
import {
  ArchiveCrewNotFoundError,
  ArchiveCrewService,
  type ArchiveCrewInput,
} from "./ArchiveCrewService.ts";
import { ClientActionsService, layer } from "./ClientActionsService.ts";
import { ExchangeId, LedgerMessageId, LedgerProjectId, ParticipantId } from "./contracts.ts";
import { CrewProposalNotOpenError, CrewProposalService } from "./CrewProposalService.ts";
import {
  CrewRuntimeRequestConflictError,
  CrewRuntimeRequestService,
  type RespondToCrewRuntimeRequestInput,
} from "./CrewRuntimeRequestService.ts";
import { CrewStopNotFoundError, CrewStopService, type StopCrewInput } from "./CrewStopService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";

const seat = (name: string) => ParticipantId.make(`agent:j5:a2a:thread:${name}`);

const proposal: CrewProposal = {
  id: "proposal:1",
  projectId: LedgerProjectId.make("project:gate"),
  captainParticipantId: seat("captain"),
  captainThreadId: ThreadId.make("thread:captain"),
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  brief: "Fix the flaky login test.",
  displayName: "Login Fix Crew",
  requestedSeats: [
    { workspace: { type: "shared" }, seat: "builder", agentId: "builder", reason: "Builds" },
  ],
  approvedSeats: null,
  createdAt: "2026-09-09T16:00:00.000Z",
  resolvedAt: null,
  reportedAt: null,
  playbook: { name: "release", definitionPath: "/repo/.j5/playbooks/release.yaml" },
};

const calls = () => ({
  stops: [] as Array<StopCrewInput>,
  archives: [] as Array<ArchiveCrewInput>,
  responses: [] as Array<RespondToCrewRuntimeRequestInput>,
  answerCommandIds: [] as Array<string>,
  notified: 0,
});

const serviceWith = (seen: ReturnType<typeof calls>) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CrewStopService)({
          stop: (input) => {
            seen.stops.push(input);
            return input.crewInstanceId === "crew:1"
              ? Effect.succeed({
                  crewInstanceId: "crew:1",
                  members: [
                    {
                      seatName: "builder",
                      participantId: seat("builder"),
                      result: "interrupt_requested" as const,
                    },
                    {
                      seatName: "ghost",
                      participantId: seat("ghost"),
                      result: "never_created" as const,
                    },
                  ],
                })
              : Effect.fail(new CrewStopNotFoundError({ crewInstanceId: input.crewInstanceId }));
          },
        }),
        Layer.mock(ArchiveCrewService)({
          archive: (input) => {
            seen.archives.push(input);
            return input.crewInstanceId === "crew:1"
              ? Effect.succeed({
                  status: "archived" as const,
                  members: [
                    {
                      seatName: "builder",
                      participantId: seat("builder"),
                      result: "archived" as const,
                    },
                    {
                      seatName: "critic",
                      participantId: seat("critic"),
                      result: "already_archived" as const,
                    },
                    {
                      seatName: "ghost",
                      participantId: seat("ghost"),
                      result: "never_created" as const,
                    },
                  ],
                })
              : Effect.fail(new ArchiveCrewNotFoundError({ crewInstanceId: input.crewInstanceId }));
          },
        }),
        Layer.mock(CrewRuntimeRequestService)({
          respond: (input) => {
            seen.responses.push(input);
            return seen.responses.length === 1
              ? Effect.void
              : Effect.fail(new CrewRuntimeRequestConflictError({ detail: "already resolved" }));
          },
        }),
        Layer.mock(CrewProposalService)({
          resolve: (input) =>
            input.proposalId === proposal.id
              ? Effect.succeed({
                  proposal: { ...proposal, status: "approved" as const },
                  instance: null,
                })
              : Effect.fail(
                  new CrewProposalNotOpenError({
                    proposalId: input.proposalId,
                    status: "declined",
                  }),
                ),
        }),
        Layer.mock(PlaybookStore)({
          readPath: () =>
            Effect.succeed({
              name: "release",
              title: "Release",
              description: "Ship.",
              steps: [{ id: "plan", title: "Plan", prompt: "Plan." }],
              warnings: [],
            }),
        }),
        Layer.mock(A2AHumanInbox)({
          answer: (input) => {
            seen.answerCommandIds.push(input.commandId);
            return Effect.succeed({
              messageId: LedgerMessageId.make(`message:test:${input.exchangeId}`),
              exchangeId: input.exchangeId,
              exchangeState: "closed" as const,
              joinedExistingExchange: false,
              durableAtSeq: 1,
            });
          },
        }),
        Layer.mock(A2ADeliveryWorker)({
          notify: Effect.sync(() => {
            seen.notified += 1;
          }),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

it.effect(
  "stops a Crew as a person: no Captain check, fresh per-seat ids, created seats only",
  () => {
    const seen = calls();
    return Effect.gen(function* () {
      const actions = yield* ClientActionsService;
      const stopped = yield* actions.stopCrew({ crewInstanceId: "crew:1" });
      // The never-created ghost seat is left out, so every client decodes the members it gets.
      assert.deepStrictEqual(stopped, {
        crewInstanceId: "crew:1",
        members: [
          { seat: "builder", participantId: seat("builder"), result: "interrupt_requested" },
        ],
      });
      yield* actions.stopCrew({ crewInstanceId: "crew:1" });
      const [first, second] = seen.stops;
      assert.isNull(first?.callerParticipantId);
      assert.isNull(first?.projectId);
      assert.notEqual(
        first?.commandIds("builder").interruptCommandId,
        first?.commandIds("critic").interruptCommandId,
      );
      // Each click is one stop: two clicks cannot share command ids.
      assert.notEqual(
        first?.commandIds("builder").interruptCommandId,
        second?.commandIds("builder").interruptCommandId,
      );
      const missing = yield* actions.stopCrew({ crewInstanceId: "crew:nope" }).pipe(Effect.flip);
      assert.equal(missing._tag, "CrewStopNotFoundError");
    }).pipe(Effect.provide(serviceWith(seen)));
  },
);

it.effect("archives a Crew as a person, with the dialog's confirmation already satisfied", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const archived = yield* actions.archiveCrew({ crewInstanceId: "crew:1" });
    assert.equal(archived.status, "archived");
    assert.deepStrictEqual(
      archived.members.map((member) => [member.seat, member.result]),
      [
        ["builder", "archived"],
        ["critic", "already_archived"],
      ],
    );
    // A person is not a participant and confirmed the dialog: no Captain check, no token dance.
    const [input] = seen.archives;
    assert.isNull(input?.callerParticipantId);
    assert.isNull(input?.projectId);
    assert.isTrue(input?.confirmationSatisfied);
    assert.isUndefined(input?.confirmationToken);
    assert.notEqual(
      input?.commandIds("builder").archiveCommandId,
      input?.commandIds("critic").archiveCommandId,
    );
    assert.notEqual(
      input?.commandIds("builder").archiveCommandId,
      input?.commandIds("builder").interruptCommandId,
    );
    const missing = yield* actions.archiveCrew({ crewInstanceId: "crew:nope" }).pipe(Effect.flip);
    assert.equal(missing._tag, "ArchiveCrewNotFoundError");
  }).pipe(Effect.provide(serviceWith(seen)));
});

it.effect("answers a seat's approval with its own command id, so a repeat is refused", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const answer = {
      threadId: ThreadId.make("thread:builder"),
      requestId: RuntimeRequestId.make("req:1"),
      decision: "accept" as const,
    };
    assert.deepStrictEqual(yield* actions.respondCrewRuntimeRequest(answer), {
      threadId: answer.threadId,
      requestId: answer.requestId,
    });
    const repeat = yield* actions.respondCrewRuntimeRequest(answer).pipe(Effect.flip);
    assert.equal(repeat._tag, "CrewRuntimeRequestConflictError");
    assert.lengthOf(seen.responses, 2);
    assert.notEqual(seen.responses[0]!.commandId, seen.responses[1]!.commandId);
  }).pipe(Effect.provide(serviceWith(seen)));
});

it.effect("resolves a proposal and answers with it as the card reads it", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const resolved = yield* actions.resolveCrewProposal({
      proposalId: proposal.id,
      decision: "approve",
      approvalToken: "runtime-token",
    });
    assert.equal(resolved.proposal.status, "approved");
    assert.isNull(resolved.crewInstanceId);
    // The stored reference becomes the live definition's summary.
    assert.deepStrictEqual(resolved.proposal.playbook, {
      name: "release",
      title: "Release",
      steps: [{ id: "plan", title: "Plan" }],
      issue: null,
    });
    const stale = yield* actions
      .resolveCrewProposal({ proposalId: "other", decision: "decline" })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "CrewProposalNotOpenError");
  }).pipe(Effect.provide(serviceWith(seen)));
});

it.effect(
  "answers an Exchange under a command id of person, exchange and request, then wakes delivery",
  () => {
    const seen = calls();
    return Effect.gen(function* () {
      const actions = yield* ClientActionsService;
      const personId = ParticipantId.make("human:local-operator");
      const first = ExchangeId.make("exchange:same-client:first");
      const second = ExchangeId.make("exchange:same-client:second");
      const clientRequestId = "reused-client-request";
      for (const exchangeId of [first, second]) {
        const answered = yield* actions.answerHumanExchange({
          personId,
          exchangeId,
          message: `Answer for ${exchangeId}`,
          clientRequestId,
        });
        assert.equal(answered.result.exchangeId, exchangeId);
      }
      // One client request id reused across two Exchanges still makes two commands.
      assert.deepStrictEqual(seen.answerCommandIds, [
        `command:j5:a2a:human:${encodeURIComponent(personId)}:${encodeURIComponent(first)}:${encodeURIComponent(clientRequestId)}`,
        `command:j5:a2a:human:${encodeURIComponent(personId)}:${encodeURIComponent(second)}:${encodeURIComponent(clientRequestId)}`,
      ]);
      assert.equal(seen.notified, 2);
    }).pipe(Effect.provide(serviceWith(seen)));
  },
);
