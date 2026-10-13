import {
  type ClientGuardedRpcTag,
  J5_ARTIFACT_WS_METHODS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  J5_CLIENT_ACTION_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  J5_PLAYBOOK_WS_METHODS,
  type J5ReadRevisionKey,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
  request,
} from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";
import { sharingConnectionIsKnownGuest } from "./sharing.ts";

const defectText = (defect: unknown) => (defect instanceof Error ? defect.message : String(defect));

/** A server too old to have the method answers with an "Unknown request tag" defect. */
const isUnknownRequestTag = (cause: Cause.Cause<unknown>, tag: string) =>
  cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      defectText(reason.defect).includes(`Unknown request tag: ${tag}`),
  );

/** That defect as a failure the control or view shows, in the words upstream uses for a server that must be updated. */
const needsNewerServer = (environmentId: EnvironmentId, subject: "action" | "view") =>
  new EnvironmentRpcUnavailableError({
    environmentId,
    message: `This ${subject} needs a newer server. Update the server hosting this environment, then try again.`,
  });

/**
 * A J5 action as a permission-aware command: `permissionAtom` says whether the session may run it,
 * and the same grant is checked again when it runs.
 */
const createJ5ActionCommand = <R, E, TTag extends EnvironmentUnaryRpcTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  label: string,
  tag: TTag,
) => {
  const command = createEnvironmentRpcCommand(runtime, { label, tag });
  const run: typeof command.run = async (registry, target) => {
    const result = await command.run(registry, target);
    return AsyncResult.isFailure(result) && isUnknownRequestTag(result.cause, tag)
      ? AsyncResult.failure(Cause.fail(needsNewerServer(target.environmentId, "action")))
      : result;
  };
  return { ...command, run };
};

type J5ReadTag = Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>;

/**
 * The J5 reads a guest's client still sends: the ones the server answers for a guest holding the
 * grant (`GUEST_RPC_RULES` in the server's `j5/sharing/GuestGate.ts`). A project's artifacts are
 * readable by a guest of that project (Shared server AC9). A read the server starts to allow a
 * guest is added here, or the guest's client never asks.
 */
const READS_A_GUEST_SENDS: ReadonlySet<string> = new Set([
  J5_ARTIFACT_WS_METHODS.listArtifacts,
  J5_CLIENT_READ_WS_METHODS.listThreadRosters,
]);

/**
 * One J5 read over the environment's socket. No J5 read is a guarded method. A guest is shown
 * nothing of the server's inbox, Fleet page, Crews or Playbooks (Shared server AC24) and the
 * server refuses each of these reads, so once the connection is known to be a guest's only the
 * reads in `READS_A_GUEST_SENDS` go out. The check does not wait for that answer, so a member's
 * reads are not delayed.
 */
const j5Read = <TTag extends J5ReadTag>(tag: TTag, input: EnvironmentRpcInput<TTag>) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    if (!READS_A_GUEST_SENDS.has(tag) && (yield* sharingConnectionIsKnownGuest)) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: supervisor.target.environmentId,
        message: "This is not shared with you on this server.",
      });
    }
    return yield* request(tag, input).pipe(
      Effect.catchCauseIf(
        (cause) => isUnknownRequestTag(cause, tag),
        () => Effect.fail(needsNewerServer(supervisor.target.environmentId, "view")),
      ),
    );
  });

/** J5 uses the same environment registry, query lifecycle, and command dispatch as other features. */
export function createJ5EnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Which reads the server says went out of date. A query that names its revisions here re-reads
  // when one of them moves, and holds this subscription open for as long as it is mounted.
  const readChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "j5:read-changes",
    tag: J5_CLIENT_READ_WS_METHODS.subscribeReadChanges,
  });
  // One value per set of revisions, so a query re-reads only when a revision it depends on moved.
  const readRevisions = Atom.family((key: string) => {
    const [environmentId, ...keys] = JSON.parse(key) as [EnvironmentId, ...J5ReadRevisionKey[]];
    return Atom.make((get) => {
      const revisions = Option.getOrNull(
        AsyncResult.value(get(readChanges({ environmentId, input: {} }))),
      );
      return revisions === null ? null : keys.map((name) => revisions[name]).join(":");
    }).pipe(Atom.withLabel(`j5:read-revisions:${key}`));
  });
  const rereadOn =
    (...keys: ReadonlyArray<J5ReadRevisionKey>) =>
    (target: { readonly environmentId: EnvironmentId }) =>
      readRevisions(JSON.stringify([target.environmentId, ...keys]));
  return {
    readChanges,
    /** A `refreshTrigger` for a read made elsewhere that one of the server's revisions covers. */
    rereadOn,
    playbookChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "j5:playbook-changes",
      tag: J5_PLAYBOOK_WS_METHODS.subscribeChanges,
      idleTtlMs: 0,
    }),
    playbookRuns: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "j5:playbook-runs",
      tag: J5_PLAYBOOK_WS_METHODS.listRuns,
      execute: (input) => j5Read(J5_PLAYBOOK_WS_METHODS.listRuns, input),
      staleTimeMs: 2_500,
    }),
    playbookLibrary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "j5:playbook-library",
      tag: J5_PLAYBOOK_WS_METHODS.readLibrary,
      execute: (input) => j5Read(J5_PLAYBOOK_WS_METHODS.readLibrary, input),
      staleTimeMs: 0,
    }),
    deletePlaybook: createJ5ActionCommand(
      runtime,
      "j5:delete-playbook",
      J5_PLAYBOOK_WS_METHODS.deletePlaybook,
    ),
    listArtifacts: createEnvironmentRpcCommand(runtime, {
      label: "j5:list-artifacts",
      tag: J5_ARTIFACT_WS_METHODS.listArtifacts,
      execute: (input) => j5Read(J5_ARTIFACT_WS_METHODS.listArtifacts, input),
    }),
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
    playbooks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "j5:playbooks",
      tag: J5_PLAYBOOK_WS_METHODS.listThreadRuns,
      execute: (input) => j5Read(J5_PLAYBOOK_WS_METHODS.listThreadRuns, input),
      staleTimeMs: 2_500,
    }),
    inbox: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "j5:inbox",
      tag: J5_CLIENT_READ_WS_METHODS.listHumanInbox,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.listHumanInbox, input),
      staleTimeMs: 7_500,
      refreshTrigger: rereadOn("inbox"),
    }),
    openCount: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "j5:inbox-count",
      tag: J5_CLIENT_READ_WS_METHODS.readOpenInboxCount,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.readOpenInboxCount, input),
      staleTimeMs: 7_500,
      refreshTrigger: rereadOn("inbox"),
    }),
    // The Fleet page reads every connected environment's roster: its agents and their open
    // Exchanges, and its Crews with their seats.
    fleet: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "j5:fleet",
      tag: J5_CLIENT_READ_WS_METHODS.readFleet,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.readFleet, input),
      staleTimeMs: 30_000,
      refreshTrigger: rereadOn("crew", "fleet"),
    }),
    // The sidebar asks about the rows it shows, a batch at a time (`scopedThreadReadStore`).
    listCrewMemberships: createEnvironmentRpcCommand(runtime, {
      label: "j5:crew-memberships",
      tag: J5_CLIENT_READ_WS_METHODS.listCrewMemberships,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.listCrewMemberships, input),
    }),
    listSpawnedChildren: createEnvironmentRpcCommand(runtime, {
      label: "j5:spawned-children",
      tag: J5_CLIENT_READ_WS_METHODS.listSpawnedChildren,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.listSpawnedChildren, input),
    }),
    // What the archive dialog lists before a thread is archived, and the names it lists them by.
    readPreArchiveFacts: createEnvironmentRpcCommand(runtime, {
      label: "j5:pre-archive-facts",
      tag: J5_CLIENT_READ_WS_METHODS.readPreArchiveFacts,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.readPreArchiveFacts, input),
    }),
    readParticipantIdentities: createEnvironmentRpcCommand(runtime, {
      label: "j5:participant-identities",
      tag: J5_CLIENT_READ_WS_METHODS.readParticipantIdentities,
      execute: (input) => j5Read(J5_CLIENT_READ_WS_METHODS.readParticipantIdentities, input),
    }),
    // Crew gates are read per environment like the inbox; a Captain on any connected server
    // reaches the human's bell and thread.
    crewProposals: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:crew-proposals",
      staleTimeMs: 7_500,
      refreshTrigger: rereadOn("crew"),
      execute: (_input: Record<string, never>) =>
        j5Read(J5_CLIENT_READ_WS_METHODS.listCrewProposals, {}).pipe(
          Effect.map((response) => response.proposals),
        ),
    }),
    // The rosters waiting on one thread: what a guest reads, since the list of every open
    // proposal is not theirs. The server has no feed a guest may follow, so the gate asks again
    // when the thread's run changes.
    threadRosters: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:thread-rosters",
      staleTimeMs: 0,
      execute: (input: { readonly threadId: ThreadId }) =>
        j5Read(J5_CLIENT_READ_WS_METHODS.listThreadRosters, input).pipe(
          Effect.map((response) => response.proposals),
        ),
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
    // Crew seats' provider approvals answered from the Inbox. The list changes when an approval
    // does, and when a Crew gains, loses or retires the seat it is on.
    crewRuntimeRequests: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:crew-runtime-requests",
      staleTimeMs: 7_500,
      refreshTrigger: rereadOn("crew", "runtimeRequests"),
      execute: (_input: Record<string, never>) =>
        j5Read(J5_CLIENT_READ_WS_METHODS.listCrewRuntimeRequests, {}).pipe(
          Effect.map((response) => response.requests),
        ),
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
    // Polls, backlogs and errors change while Connections stays open; each moves the `peers`
    // revision. A polling peer's heartbeat moves it well inside the two-minute online window.
    peers: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:peers",
      staleTimeMs: 30_000,
      refreshTrigger: rereadOn("peers"),
      execute: (_input: Record<string, never>) =>
        j5Read(J5_CLIENT_READ_WS_METHODS.listPeers, {}).pipe(
          Effect.map((response) => response.peers),
        ),
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
