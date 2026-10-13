import { J5_ARTIFACT_WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { J5_CLIENT_ACTION_WS_METHODS, J5_PLAYBOOK_WS_METHODS } from "@t3tools/contracts/j5";
import type {
  FleetReadRequest,
  PlaybookLibraryRequest,
  PlaybookRunsRequest,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { AsyncResult, type Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, type EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";
import * as J5Http from "./http.ts";
import { sharingConnectionIsKnownGuest } from "./sharing.ts";

const preparedConnection = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  const state = yield* SubscriptionRef.get(supervisor.state);
  if (Option.isNone(prepared) || state.phase !== "connected") {
    return yield* new J5Http.J5HttpError({ status: 0, detail: "The environment is disconnected." });
  }
  // A guest is shown nothing of the server's inbox, Fleet page, Crews or Playbooks (Shared server
  // AC24) and the server refuses each of these reads. Once the connection is known to be a
  // guest's, none is sent: the read reports the environment as one without the feature, which is
  // never polled. The check does not wait for that answer, so a member's reads are not delayed.
  if (yield* sharingConnectionIsKnownGuest) {
    return yield* new J5Http.J5HttpError({
      status: 501,
      detail: "This is not shared with you on this server.",
    });
  }
  return prepared.value;
});

export const supportedJ5Read = <A extends object, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.map((data) => ({ ...data, supported: true as const })),
    Effect.catchIf(J5Http.isJ5UnsupportedError, () =>
      Effect.succeed({ supported: false as const }),
    ),
  );

const defectText = (defect: unknown) => (defect instanceof Error ? defect.message : String(defect));

/**
 * A J5 action as a permission-aware command: `permissionAtom` says whether the session may run it,
 * and the same grant is checked again when it runs.
 *
 * A server too old to have the method answers with an "Unknown request tag" defect. That becomes
 * a failure the control shows, in the words upstream uses for a server that must be updated.
 */
const createJ5ActionCommand = <R, E, TTag extends EnvironmentUnaryRpcTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  label: string,
  tag: TTag,
) => {
  const command = createEnvironmentRpcCommand(runtime, { label, tag });
  const run: typeof command.run = async (registry, target) => {
    const result = await command.run(registry, target);
    return AsyncResult.isFailure(result) &&
      result.cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          defectText(reason.defect).includes(`Unknown request tag: ${tag}`),
      )
      ? AsyncResult.failure(
          Cause.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: target.environmentId,
              message:
                "This action needs a newer server. Update the server hosting this environment, then try again.",
            }),
          ),
        )
      : result;
  };
  return { ...command, run };
};

/** J5 uses the same environment registry, query lifecycle, and command dispatch as other features. */
export function createJ5EnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    playbookChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "j5:playbook-changes",
      tag: J5_PLAYBOOK_WS_METHODS.subscribeChanges,
      idleTtlMs: 0,
    }),
    playbookRuns: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:playbook-runs",
      staleTimeMs: 2_500,
      execute: (input: PlaybookRunsRequest) =>
        supportedJ5Read(
          preparedConnection.pipe(
            Effect.flatMap((prepared) => J5Http.readAllPlaybooks(prepared, input)),
          ),
        ),
    }),
    playbookLibrary: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:playbook-library",
      staleTimeMs: 0,
      execute: (input: PlaybookLibraryRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.readPlaybookLibrary(prepared, input)),
        ),
    }),
    deletePlaybook: createJ5ActionCommand(
      runtime,
      "j5:delete-playbook",
      J5_PLAYBOOK_WS_METHODS.deletePlaybook,
    ),
    deleteArtifact: createJ5ActionCommand(
      runtime,
      "j5:delete-artifact",
      J5_ARTIFACT_WS_METHODS.deleteArtifact,
    ),
    exportPlaybook: createEnvironmentRpcCommand(runtime, {
      label: "j5:export-playbook",
      tag: J5_PLAYBOOK_WS_METHODS.exportPlaybook,
    }),
    renamePlaybook: createJ5ActionCommand(
      runtime,
      "j5:rename-playbook",
      J5_PLAYBOOK_WS_METHODS.renamePlaybook,
    ),
    playbooks: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:playbooks",
      staleTimeMs: 2_500,
      execute: (input: { readonly threadId: ThreadId }) =>
        supportedJ5Read(
          preparedConnection.pipe(
            Effect.flatMap((prepared) => J5Http.readThreadPlaybooks(prepared, input.threadId)),
          ),
        ),
    }),
    inbox: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:inbox",
      staleTimeMs: 7_500,
      execute: (input: { readonly status: "open" | "answered"; readonly personId?: string }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) =>
            J5Http.listHumanInbox(prepared, input.status, input.personId),
          ),
        ),
    }),
    openCount: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:inbox-count",
      staleTimeMs: 7_500,
      execute: (input: { readonly personId?: string }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.readOpenInboxCount(prepared, input.personId)),
        ),
    }),
    // The Fleet page reads every connected environment's roster; it changes on the scale of turns.
    fleet: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:fleet",
      staleTimeMs: 30_000,
      execute: (input: FleetReadRequest) =>
        preparedConnection.pipe(Effect.flatMap((prepared) => J5Http.readFleet(prepared, input))),
    }),
    // Crew gates are read per environment like the inbox; a Captain on any connected server
    // reaches the human's bell and thread.
    crewProposals: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:crew-proposals",
      staleTimeMs: 7_500,
      execute: (_input: Record<string, never>) =>
        preparedConnection.pipe(Effect.flatMap(J5Http.listCrewProposals)),
    }),
    previewCrewProposal: createJ5ActionCommand(
      runtime,
      "j5:preview-crew-proposal",
      J5_CLIENT_ACTION_WS_METHODS.previewCrewProposal,
    ),
    resolveCrewProposal: createJ5ActionCommand(
      runtime,
      "j5:resolve-crew-proposal",
      J5_CLIENT_ACTION_WS_METHODS.resolveCrewProposal,
    ),
    archiveCrew: createJ5ActionCommand(
      runtime,
      "j5:archive-crew",
      J5_CLIENT_ACTION_WS_METHODS.archiveCrew,
    ),
    // Crew seats' provider approvals answered from the Inbox; same cadence as gates.
    crewRuntimeRequests: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:crew-runtime-requests",
      staleTimeMs: 7_500,
      execute: (_input: Record<string, never>) =>
        preparedConnection.pipe(Effect.flatMap(J5Http.listCrewRuntimeRequests)),
    }),
    respondCrewRuntimeRequest: createJ5ActionCommand(
      runtime,
      "j5:respond-crew-runtime-request",
      J5_CLIENT_ACTION_WS_METHODS.respondCrewRuntimeRequest,
    ),
    stopCrew: createJ5ActionCommand(runtime, "j5:stop-crew", J5_CLIENT_ACTION_WS_METHODS.stopCrew),
    answerHumanExchange: createJ5ActionCommand(
      runtime,
      "j5:answer-exchange",
      J5_CLIENT_ACTION_WS_METHODS.answerHumanExchange,
    ),
    // Polls, backlogs and errors change while Connections stays open, and
    // nothing pushes them, so the list is read again on an interval well inside
    // the two-minute online window.
    peers: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:peers",
      staleTimeMs: 30_000,
      refreshIntervalMs: 30_000,
      execute: (_input: Record<string, never>) =>
        preparedConnection.pipe(Effect.flatMap(J5Http.listPeers)),
    }),
    issuePeerCredential: createJ5ActionCommand(
      runtime,
      "j5:issue-peer-credential",
      J5_CLIENT_ACTION_WS_METHODS.issuePeerCredential,
    ),
    addPeer: createJ5ActionCommand(runtime, "j5:add-peer", J5_CLIENT_ACTION_WS_METHODS.addPeer),
    listPeerAddresses: createJ5ActionCommand(
      runtime,
      "j5:peer-addresses",
      J5_CLIENT_ACTION_WS_METHODS.listPeerAddresses,
    ),
    probePeer: createJ5ActionCommand(
      runtime,
      "j5:probe-peer",
      J5_CLIENT_ACTION_WS_METHODS.probePeer,
    ),
    removePeer: createJ5ActionCommand(
      runtime,
      "j5:remove-peer",
      J5_CLIENT_ACTION_WS_METHODS.removePeer,
    ),
  };
}
