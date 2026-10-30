import {
  AuthA2ASendScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import {
  J5_MACHINE_API_PATHS,
  MachineSendRequest,
  RegisterMachineParticipantRequest,
  type A2ARosterResponse,
  type MachineParticipantRecord as MachineParticipantWire,
  type MachineSendResponse,
  type MachineWhoamiResponse,
  type RegisterMachineParticipantResponse,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import {
  authenticate,
  jsonError,
  messageOf,
  requestFailure,
  requireAnyScope,
  respondableTags,
  tagOf,
} from "./httpSupport.ts";
import {
  MachineParticipantService,
  type MachineParticipantRecord,
} from "./MachineParticipantService.ts";
import { RosterService } from "./RosterService.ts";
import { A2ASendService } from "./SendService.ts";
import { CommCommandId, isMachineParticipantId, ParticipantId } from "./contracts.ts";

/**
 * The machine-sender HTTP surface behind `j5 a2a`. A machine token carries the
 * `a2a:send` scope and its participant id as the session subject; identity is
 * never a request field. Sends drive the same send service and command-id
 * idempotency the MCP `j5_send_message` tool uses.
 */

const decodeRegisterRequest = Schema.decodeUnknownEffect(RegisterMachineParticipantRequest);
const decodeSendRequest = Schema.decodeUnknownEffect(MachineSendRequest);

const stablePart = (value: string) => encodeURIComponent(value);

/** Same shape as the MCP tool's id so a retry with one client request id replays one receipt. */
export const machineSendCommandId = (input: {
  readonly senderParticipantId: ParticipantId;
  readonly clientRequestId: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:machine:${stablePart(input.senderParticipantId)}:send:${stablePart(input.clientRequestId)}`,
  );

export const machineRegisterCommandId = (input: {
  readonly projectId: string;
  readonly name: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:machine:register:${stablePart(input.projectId)}:${stablePart(input.name)}`,
  );

const wireRecord = (record: MachineParticipantRecord): MachineParticipantWire => ({
  participantId: record.participantId,
  projectId: record.projectId,
  projectTitle: record.projectTitle,
  name: record.name,
  createdAt: record.createdAt,
});

/** Policy refusals get one stable code so the CLI can map them to its own exit code. */
const POLICY_REFUSAL_TAGS: ReadonlySet<string> = new Set([
  "A2AParticipantArchivedError",
  "A2AMachineCannotReceiveError",
  "A2AHumanAskOrReplyRequiredError",
]);

const sendFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const tag = tagOf(error);
  const message = messageOf(error, "Send failed.");
  if (tag === "A2AParticipantNotFoundError") {
    return Effect.succeed(jsonError(404, "recipient_not_found", message));
  }
  if (tag === "A2AAmbiguousParticipantError") {
    return Effect.succeed(jsonError(409, "recipient_ambiguous", message));
  }
  if (POLICY_REFUSAL_TAGS.has(tag)) {
    return Effect.succeed(jsonError(403, "policy_refused", message, { reason: tag }));
  }
  if (tag === "A2AMachineSenderNotRegisteredError") {
    return Effect.succeed(jsonError(403, "machine_sender_not_registered", message));
  }
  if (tag === "CommCommandConflictError") {
    return Effect.succeed(jsonError(409, "client_request_id_conflict", message));
  }
  if (tag === "SchemaError") return Effect.succeed(requestFailure(message));
  return Effect.logError("J5 A2A machine send failed", { cause: error }).pipe(
    Effect.as(jsonError(500, tag, "Send failed.")),
  );
};

const registerFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const tag = tagOf(error);
  const message = messageOf(error, "Registration failed.");
  if (tag === "MachineParticipantProjectNotFoundError") {
    return Effect.succeed(jsonError(404, "project_not_found", message));
  }
  if (tag === "MachineParticipantNameTakenError") {
    return Effect.succeed(jsonError(409, "name_taken", message));
  }
  if (tag === "MachineParticipantInvalidNameError") return Effect.succeed(requestFailure(message));
  return Effect.logError("J5 A2A machine registration failed", { cause: error }).pipe(
    Effect.as(jsonError(500, tag, "Registration failed.")),
  );
};

export const machineSenderHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const machines = yield* MachineParticipantService;
    const sendService = yield* A2ASendService;
    const worker = yield* A2ADeliveryWorker;
    const roster = yield* RosterService;

    /** The token's subject must name a registered machine; anything else is refused with the next command. */
    const machineForSession = Effect.fn("j5.a2a.machineSenderHttp.machineForSession")(function* (
      session: EnvironmentAuth.AuthenticatedSession,
    ) {
      const subject = ParticipantId.make(session.subject);
      if (!isMachineParticipantId(subject)) {
        return Result.fail(
          jsonError(
            403,
            "machine_subject_required",
            `This token is not bound to a machine participant (subject "${session.subject}"). Issue one with \`j5 a2a token issue --participant <name>\`.`,
          ),
        );
      }
      const resolved = yield* Effect.result(machines.resolve(subject));
      return Result.isSuccess(resolved)
        ? Result.succeed(resolved.success)
        : Result.fail(
            tagOf(resolved.failure) === "MachineParticipantNotFoundError"
              ? jsonError(
                  403,
                  "machine_sender_not_registered",
                  messageOf(resolved.failure, "Machine participant is not registered."),
                )
              : jsonError(500, tagOf(resolved.failure), "Machine lookup failed."),
          );
    });

    const registerRoute = HttpRouter.add(
      "POST",
      J5_MACHINE_API_PATHS.machineParticipants,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.machine.register");
        const session = yield* authenticate;
        yield* requireAnyScope(session, [AuthOrchestrationOperateScope]);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeRegisterRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "projectId and a name of 1-64 lowercase letters, digits, or hyphens are required.",
          );
        }
        const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const result = yield* Effect.result(
          machines.register({
            commandId: machineRegisterCommandId({
              projectId: decoded.success.projectId,
              name: decoded.success.name,
            }),
            projectId: decoded.success.projectId as MachineParticipantRecord["projectId"],
            name: decoded.success.name,
            acceptedAt,
          }),
        );
        if (Result.isFailure(result)) return yield* registerFailure(result.failure);
        return HttpServerResponse.jsonUnsafe(
          {
            participant: wireRecord(result.success.participant),
            created: result.success.created,
          } satisfies RegisterMachineParticipantResponse,
          { status: result.success.created ? 201 : 200 },
        );
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const sendRoute = HttpRouter.add(
      "POST",
      J5_MACHINE_API_PATHS.send,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.machine.send");
        const session = yield* authenticate;
        yield* requireAnyScope(session, [AuthA2ASendScope]);
        const machine = yield* machineForSession(session);
        if (Result.isFailure(machine)) return machine.failure;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeSendRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure("to, a non-empty message, and clientRequestId are required.");
        }
        const recipient = yield* roster.resolveRecipient(decoded.success.to);
        if (recipient.kind === "not_found") {
          return jsonError(
            404,
            "recipient_not_found",
            `No participant, thread, or agent display name matches "${decoded.success.to}". Run \`j5 a2a list\` to see the roster.`,
          );
        }
        if (recipient.kind === "ambiguous") {
          return jsonError(
            409,
            "recipient_ambiguous",
            `Display name "${decoded.success.to}" matches ${String(recipient.candidates.length)} agents. Address one by participant id or thread id.`,
            {
              candidates: recipient.candidates.map((candidate) => ({
                participantId: candidate.participantId,
                threadId: candidate.threadId,
                displayName: candidate.displayName,
                projectTitle: candidate.projectTitle,
              })),
            },
          );
        }
        const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const sent = yield* Effect.result(
          sendService.sendAsMachine({
            commandId: machineSendCommandId({
              senderParticipantId: machine.success.participantId,
              clientRequestId: decoded.success.clientRequestId,
            }),
            senderParticipantId: machine.success.participantId,
            to: recipient.participantId,
            message: decoded.success.message,
            acceptedAt,
          }),
        );
        if (Result.isFailure(sent)) return yield* sendFailure(sent.failure);
        yield* worker.notify;
        return HttpServerResponse.jsonUnsafe({
          sender: machine.success.participantId,
          receiver: recipient.participantId,
          result: sent.success,
        } satisfies MachineSendResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const rosterRoute = HttpRouter.add(
      "GET",
      J5_MACHINE_API_PATHS.roster,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.machine.roster");
        const session = yield* authenticate;
        yield* requireAnyScope(session, [AuthOrchestrationReadScope, AuthA2ASendScope]);
        const participants = yield* Effect.result(roster.list());
        if (Result.isFailure(participants)) {
          yield* Effect.logError("J5 A2A roster read failed", { cause: participants.failure });
          return jsonError(500, tagOf(participants.failure), "Roster read failed.");
        }
        return HttpServerResponse.jsonUnsafe({
          participants: participants.success,
        } satisfies A2ARosterResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const whoamiRoute = HttpRouter.add(
      "GET",
      J5_MACHINE_API_PATHS.whoami,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.machine.whoami");
        const session = yield* authenticate;
        yield* requireAnyScope(session, [AuthA2ASendScope]);
        const machine = yield* machineForSession(session);
        if (Result.isFailure(machine)) return machine.failure;
        return HttpServerResponse.jsonUnsafe({
          participant: wireRecord(machine.success),
          server: { version: packageJson.version },
        } satisfies MachineWhoamiResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    return Layer.mergeAll(registerRoute, sendRoute, rosterRoute, whoamiRoute);
  }),
);
