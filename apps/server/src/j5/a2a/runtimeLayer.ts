import * as Layer from "effect/Layer";
import { layerEventSink as OrchestrationV2EventSinkLayerLive } from "../../orchestration-v2/runtimeLayer.ts";
import { layer as playbookCrewRelayLayer } from "../playbooks/PlaybookCrewRelay.ts";
import { layer as playbookDefinitionWatchLayer } from "../playbooks/PlaybookDefinitionWatch.ts";
import { playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
import { FetchHttpClient } from "effect/http";

import { layer as artifactDeletionLayer } from "../artifacts/ArtifactDeletion.ts";
import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";
import { layerNotifying as agentCrewInstanceNotifyingLayer } from "./AgentCrewInstanceService.ts";
import { layer as archiveFactsLayer, placementFactsLayer } from "./ArchiveFactsService.ts";
import { layer as archiveAgentLayer } from "./ArchiveAgentService.ts";
import { layer as archiveCrewLayer } from "./ArchiveCrewService.ts";
import { layerNotifying as agentCrewProposalNotifyingLayer } from "./AgentCrewProposalService.ts";
import { manualLayer as crewLaunchReporterLayer } from "./CrewLaunchReporter.ts";
import { layer as crewLaunchLayer } from "./CrewLaunchService.ts";
import { layer as crewProposalLayer } from "./CrewProposalService.ts";
import { layer as crewSeatFinishNotifierLayer } from "./CrewSeatFinishNotifier.ts";
import { layer as captainArchiveCascadeLayer } from "./CrewCaptainArchiveCascade.ts";
import { layer as crewStopLayer } from "./CrewStopService.ts";
import { layer as crewRuntimeRequestLayer } from "./CrewRuntimeRequestService.ts";
import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import {
  layer as homeRegistrarLayer,
  transactionLayer as homeRegistrationTransactionLayer,
} from "./HomeRegistrar.ts";
import { humanPersonRegistryLayer } from "./HumanPersonRegistry.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { layer as participantPlacementLayer } from "./PlacementService.ts";
import { layer as lifecycleServiceLayer } from "./LifecycleService.ts";
import { layer as machineParticipantLayer } from "./MachineParticipantService.ts";
import { layer as peerDirectoryLayer } from "./PeerDirectory.ts";
import { layer as peerInboundLayer } from "./PeerInboundService.ts";
import { layer as peerStoreLayer } from "./PeerStoreService.ts";
import { layer as peerPollerLayer } from "./PeerPoller.ts";
import { layer as peerRemovalLayer } from "./PeerRemovalService.ts";
import { layer as peerRegistryLayer } from "./PeerRegistryService.ts";
import { layer as readChangeFeedsLayer } from "./ReadChangeFeeds.ts";
import { layer as readChangesLayer } from "./ReadChanges.ts";
import { layer as rosterLayer } from "./RosterService.ts";
import { layer as sendServiceLayer } from "./SendService.ts";
import { layer as silenceDetectorLayer } from "./SilenceDetector.ts";
import { layer as humanInboxLayer } from "./HumanInboxService.ts";
import { layer as clientActionsLayer } from "./ClientActionsService.ts";
import { layer as clientReadsLayer } from "./ClientReadsService.ts";
import { layer as peerAdminLayer } from "./PeerAdminService.ts";
import { layer as threadRegistrationLayer } from "./ThreadRegistration.ts";
import { layer as spawnCompositionLayer } from "./SpawnCompositionService.ts";
import { layer as spawnWorkspaceLayer } from "./spawnWorkspace.ts";
import { layer as agentHandoffArtifactDeleteLayer } from "../agents/agentHandoffArtifactDelete.ts";
import { layer as agentHandoffNudgeQueueLayer } from "../agents/agentHandoffNudgeQueue.ts";
import { layer as agentHandoffNudgeWorkerLayer } from "../agents/agentHandoffNudgeWorker.ts";
import { layer as agentHandoffRefreshesLayer } from "../agents/agentHandoffRefreshes.ts";
import { layer as exchangeAnalyticsLayer } from "../analytics/ExchangeAnalytics.ts";
import { layer as fleetSnapshotLayer } from "../analytics/FleetSnapshot.ts";
import { layer as threadAnalyticsLayer } from "../analytics/ThreadAnalytics.ts";

// One `ReadChanges` for the server: `readChangesLayer` is the same layer object wherever it is
// provided below, so Effect memoizes one instance for the writers that notify it and the
// WebSocket handler that streams it. The Crew stores are each one object for the same reason.
const agentCrewInstanceLayer = agentCrewInstanceNotifyingLayer.pipe(
  Layer.provide(readChangesLayer),
);
const agentCrewProposalLayer = agentCrewProposalNotifyingLayer.pipe(
  Layer.provide(readChangesLayer),
);

/**
 * Registration, homes and placement. This subset has no ThreadManagement dependency, so
 * production provides it once to the V2 runtime (which `ThreadLineage` decorates) and the
 * authenticated route graph reuses it.
 */
export const makeJ5ThreadRegistrationLayer = (
  options: { readonly ledger?: typeof ledgerLayer } = {},
) => {
  const ledgerProvided = options.ledger ?? ledgerLayer;
  return Layer.merge(
    threadRegistrationLayer,
    spawnCompositionLayer.pipe(Layer.provide(readChangesLayer)),
  ).pipe(
    Layer.provideMerge(homeRegistrationTransactionLayer),
    Layer.provideMerge(participantPlacementLayer),
    Layer.provideMerge(homeRegistrarLayer),
    Layer.provideMerge(ledgerProvided),
  );
};

export const J5ThreadRegistrationLayer = makeJ5ThreadRegistrationLayer();

// Peering reaches other servers, so its layers carry their own HTTP client.
// This server's identity and name come from the server's own environment
// descriptor, the one its clients read. The registry is built once here and
// shared by the outbound transport, the peer directory the send service
// resolves through, and the peer routes.
// One HTTP client serves every layer that reaches a peer. It never follows a
// redirect: a request that carries this server's credential, acks or roster
// goes only to the origin it was addressed to.
export const peerHttpClient = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
);
const peerRegistryProvided = peerRegistryLayer.pipe(Layer.provide(peerHttpClient));
const peerDirectoryProvided = peerDirectoryLayer.pipe(
  Layer.provide(peerRegistryProvided),
  Layer.provide(peerHttpClient),
);

/** The production transport with its peer side satisfied; tests substitute a transport layer of their own. */
const deliveryTransportWithPeers = deliveryTransportLayer.pipe(
  Layer.provide(peerRegistryProvided),
  Layer.provide(peerHttpClient),
);

export const makeJ5A2AAuxiliaryLayer = (
  options: {
    readonly deliveryTransport?: typeof deliveryTransportWithPeers;
    readonly spawnWorkspace?: typeof spawnWorkspaceLayer;
  } = {},
) => {
  const deliveryTransportProvided = options.deliveryTransport ?? deliveryTransportWithPeers;
  // One instance for j5_spawn_agent (the MCP handlers read it from this graph) and CrewLaunch: its
  // in-flight start guard is in-process, so a second build would reopen the race it closes.
  const spawnWorkspaceProvided = options.spawnWorkspace ?? spawnWorkspaceLayer;
  const sendServiceProvided = sendServiceLayer.pipe(Layer.provide(peerDirectoryProvided));
  const deliveryWorkerProvided = deliveryWorkerLayer.pipe(
    Layer.provideMerge(deliveryTransportProvided),
  );
  // The detector reads Crew membership to stay quiet about a seat failure its Captain hears elsewhere.
  const silenceDetectorProvided = silenceDetectorLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  const lifecycleServiceProvided = lifecycleServiceLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
  );
  // A polling peer's messages are handed out by the worker that owns their rows.
  const peerStoreProvided = peerStoreLayer.pipe(Layer.provideMerge(deliveryWorkerProvided));
  const peerRemovalProvided = peerRemovalLayer.pipe(Layer.provideMerge(deliveryWorkerProvided));
  // A peer this server polls is polled from the moment the server starts.
  const peerPollerProvided = peerPollerLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
    Layer.provide(peerInboundLayer),
    Layer.provide(rosterLayer),
    Layer.provide(peerHttpClient),
  );
  const archiveFactsProvided = archiveFactsLayer.pipe(Layer.provide(placementFactsLayer));
  // The saved-agent handoff worker drains the queue the run-finalization observer fills; the
  // queue layer is the same instance server.ts provides to that observer.
  const agentHandoffNudgeWorkerProvided = agentHandoffNudgeWorkerLayer.pipe(
    Layer.provide(agentHandoffNudgeQueueLayer),
  );
  const archiveAgentProvided = archiveAgentLayer.pipe(
    Layer.provideMerge(lifecycleServiceProvided),
    Layer.provideMerge(archiveFactsProvided),
  );
  // Archiving a Crew cancels its playbook run through the one store object, so the store's
  // permit and revision are never duplicated.
  const archiveCrewProvided = archiveCrewLayer.pipe(
    Layer.provideMerge(archiveAgentProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(playbookStoreLayer),
  );
  // Hands each landing of a Crew-linked run to the seat that owns it, inside the Captain's step
  // calls; a pending hand-off is finished by the Captain's next or retried call.
  const playbookCrewRelayProvided = playbookCrewRelayLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(playbookStoreLayer),
  );
  const crewLaunchProvided = crewLaunchLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(spawnWorkspaceProvided),
  );
  // The report watches the seats an approval launched and tells the Captain how they started; the
  // finish notifier's stream feeds it, so one stream serves every Crew reaction.
  // Both Crew reactions raise failure alerts, which wake the one delivery worker after committing.
  const crewLaunchReporterProvided = crewLaunchReporterLayer.pipe(
    Layer.provideMerge(playbookStoreLayer),
    Layer.provideMerge(agentCrewProposalLayer),
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(deliveryWorkerProvided),
  );
  const crewStopProvided = crewStopLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(archiveFactsProvided),
  );
  // Provider approvals and questions on live Crew threads, read and answered from the Inbox.
  const crewRuntimeRequestProvided = crewRuntimeRequestLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  // A playbook Crew is validated against the live YAML through the same store the tools use.
  const crewProposalProvided = crewProposalLayer.pipe(
    Layer.provideMerge(crewLaunchProvided),
    Layer.provideMerge(crewLaunchReporterProvided),
    Layer.provideMerge(playbookStoreLayer),
  );
  // A Captain's lifecycle carries its Crews, read from the same event stream the notifier reads.
  const captainArchiveCascadeProvided = captainArchiveCascadeLayer.pipe(
    Layer.provideMerge(archiveCrewProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  // The finish notifier tells a Captain when a seat's handoff file appears, so it reads the workspace.
  const crewSeatFinishNotifierProvided = crewSeatFinishNotifierLayer.pipe(
    Layer.provideMerge(crewLaunchReporterProvided),
    Layer.provideMerge(captainArchiveCascadeProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provide(artifactWorkspaceLayer),
  );
  const runtimeWithoutClientReads = Layer.mergeAll(
    playbookStoreLayer,
    playbookCrewRelayProvided,
    agentHandoffNudgeWorkerProvided,
    // Exported to the routes so the J5 WebSocket handler streams the same revision counter the
    // observer bumps (server.ts provides this layer object to the observer; Effect memoizes it).
    agentHandoffRefreshesLayer,
    humanPersonRegistryLayer,
    machineParticipantLayer,
    peerDirectoryProvided,
    peerInboundLayer,
    peerStoreProvided,
    peerPollerProvided,
    peerRemovalProvided,
    rosterLayer,
    sendServiceProvided,
    deliveryWorkerProvided,
    silenceDetectorProvided,
    humanInboxLayer,
    lifecycleServiceProvided,
    archiveFactsProvided,
    spawnWorkspaceProvided,
    agentCrewInstanceLayer,
    archiveCrewProvided,
    crewProposalProvided,
    crewStopProvided,
    crewRuntimeRequestProvided,
    crewSeatFinishNotifierProvided,
    threadAnalyticsLayer.pipe(Layer.provide(agentCrewInstanceLayer)),
    exchangeAnalyticsLayer,
    fleetSnapshotLayer,
    // Exported to the routes so the J5 WebSocket handler streams the revisions the writers move.
    readChangesLayer,
    // The feeds follow the one peer registry, provided below, whose writes move `peers`.
    readChangeFeedsLayer.pipe(Layer.provide(readChangesLayer), Layer.provide(playbookStoreLayer)),
    // Moves the one store's revision when the YAML of an active run changes on disk.
    playbookDefinitionWatchLayer.pipe(Layer.provide(playbookStoreLayer)),
  ).pipe(Layer.provideMerge(peerRegistryProvided));
  // The person's permanent artifact delete, which also marks a handoff that pointed at the file.
  const artifactDeletionProvided = artifactDeletionLayer.pipe(
    Layer.provide(agentHandoffArtifactDeleteLayer),
    Layer.provide(agentHandoffRefreshesLayer),
    Layer.provide(artifactWorkspaceLayer),
  );
  // What clients read and do, over the services above.
  return Layer.mergeAll(
    clientReadsLayer,
    clientActionsLayer,
    peerAdminLayer,
    artifactDeletionProvided,
  ).pipe(Layer.provideMerge(runtimeWithoutClientReads));
};

export const makeJ5A2ARuntimeLayer = (
  options: {
    readonly ledger?: typeof ledgerLayer;
    readonly deliveryTransport?: typeof deliveryTransportWithPeers;
    readonly spawnWorkspace?: typeof spawnWorkspaceLayer;
  } = {},
) => {
  const threadRegistrationProvided = makeJ5ThreadRegistrationLayer(
    options.ledger === undefined ? {} : { ledger: options.ledger },
  );
  return makeJ5A2AAuxiliaryLayer({
    ...(options.deliveryTransport === undefined
      ? {}
      : { deliveryTransport: options.deliveryTransport }),
    ...(options.spawnWorkspace === undefined ? {} : { spawnWorkspace: options.spawnWorkspace }),
  }).pipe(Layer.provideMerge(threadRegistrationProvided));
};

/**
 * Production J5 A2A services; SQL and V2 thread management stay shared dependencies. The event
 * sink is the orchestration runtime's own layer object, so Effect memoizes one instance; the
 * stream daemons read its latest sequence as their start point.
 */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer().pipe(
  Layer.provide(OrchestrationV2EventSinkLayerLive),
);
export const J5A2AAuxiliaryLayer = makeJ5A2AAuxiliaryLayer().pipe(
  Layer.provide(OrchestrationV2EventSinkLayerLive),
);
