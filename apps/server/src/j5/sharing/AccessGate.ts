import {
  ARTIFACT_READ_PATH,
  J5_AGENT_PERSONA_WS_METHODS,
  J5_SKILL_CATALOG_WS_METHODS,
  J5_SKILL_LINK_WS_METHODS,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  J5_ARTIFACT_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
  type WsRpcGroup,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import {
  type ParticipantIdentitiesResponse,
  J5_ACCESS_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  J5_PEOPLE_WS_METHODS,
  J5_PLAYBOOK_WS_METHODS,
  J5_SHARED_CONVERSATION_WS_METHODS,
  J5_SHARING_WS_METHODS,
  type PersonLevel,
  levelReaches,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import type * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import {
  Access,
  layer as accessLayer,
  renewOutdatedDevicesAtStartup,
  StaleMcpApprovalError,
} from "./Access.ts";
import { issueGuestProjectIconUrl, projectIdOfGuestIconPath } from "./GuestProjectIcons.ts";
import {
  PAIRED_AS_SOMEONE_ELSE,
  PairingIntents,
  peopleLayer as peopleRecordsLayer,
} from "./PairingIntents.ts";
import { McpApprovalGeneration } from "./McpApproval.ts";
import { layer as peopleLayer } from "./People.ts";
import {
  type MessageAsset,
  PersonAccess,
  type PersonAccessStorageError,
  type SessionIdentity,
  type SessionReach,
  isWide,
} from "./PersonAccess.ts";

/**
 * What a connection whose person's scope is narrower than the server may reach (People and access
 * AC13, AC21 to AC25). It covers everyone who does not write to the whole server: a person at a
 * project or a thread at either level, a Viewer at server scope, and a device the server cannot
 * place yet. Both halves refuse by default: a route or a request that is not named here is
 * refused to a narrowed connection, so nothing upstream adds later is open to one until it is
 * listed. What it costs a connection held to upstream's own checks alone: nothing for a service
 * session, told apart by subject; for a person's device, a few reads by key (whose the device is,
 * and their levels; for the first owner, their id and record first) on each HTTP request, and the
 * same once at each place a socket opens through: its authorization, its view, its command
 * admission and its access requests.
 *
 * The level a rule asks for is checked against the level the person holds at the scope the
 * request names. A Collaborator may also use files, terminals, git, previews and devices keyed
 * by any folder, unchecked: a terminal or an agent reaches every folder anyway (Jackson,
 * 2026-10-17). A Viewer may not, at any scope (AC24).
 */

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * A request a narrowed connection may make.
 * - `thread`, `project`: for the one the payload names, at the level given or higher.
 * - `collaborator`: for a person who holds Collaborator anywhere, whatever folder it names.
 * - `anyone`: for any person on the server; it reports or reads nothing of anyone's work.
 * - `server`: for a person who holds a level at server scope: the Fleet page, Personas and the
 *   providers' skills, whose home is the server (AC23), read only.
 * - `narrowed`: for any person, because its handler answers a narrowed connection itself, with a
 *   reduced or filtered answer (`GuestView`, `CommandAdmission`, the J5 access requests).
 * - `messageAsset`: for an attachment or a tool's image a thread within reach holds; a
 *   Collaborator may ask for any asset, since the folders they are kept in are theirs to open.
 *
 * `unknownToo` lets a device the server cannot place make it too, so it can connect far enough
 * to say whose it is (AC5).
 */
type AccessRpcRule = (
  | {
      readonly kind: "thread";
      readonly level: PersonLevel;
      readonly threadId: (payload: unknown) => string | undefined;
    }
  | {
      readonly kind: "project";
      readonly level: PersonLevel;
      readonly projectId: (payload: unknown) => string | undefined;
    }
  | {
      /** For the project or thread a `scope` field names, at the level given or higher. */
      readonly kind: "scope";
      readonly level: PersonLevel;
    }
  | { readonly kind: "collaborator" }
  | { readonly kind: "anyone" }
  /** Agents' names, each told only when the person may know that agent (`participantVisible`). */
  | { readonly kind: "identities" }
  /**
   * An MCP app's resource, in a thread the person reaches: a Viewer only the one the app the
   * payload names was published with, a Collaborator any on that app's server.
   */
  | { readonly kind: "mcpAppResource" }
  /**
   * A change to a scheduled task, at Collaborator where it is bound: the task the payload's `id`
   * names, and the thread or project an upsert binds it to.
   */
  | { readonly kind: "scheduledTask" }
  | { readonly kind: "server" }
  | { readonly kind: "narrowed" }
  | {
      readonly kind: "messageAsset";
      readonly asset: (payload: unknown) => MessageAsset | undefined;
      /** The project whose favicon the request asks for, when it asks for one by id. */
      readonly projectIcon: (payload: unknown) => ProjectId | undefined;
    }
) & { readonly unknownToo?: true };

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;

const stringField = (name: string) => (payload: unknown) => {
  const value = field(payload, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const payloadThreadId = stringField("threadId");
const payloadProjectId = stringField("projectId");

/**
 * The asset kinds a Viewer may ask a URL for: the two that are part of a conversation and that
 * the server can tie to a thread. Every kind keyed by a path or a folder (workspace, media and
 * draft files, project favicons, GitHub media) and native app icons are not named, so they are
 * refused to a Viewer.
 */
const messageAssetOf = (payload: unknown): MessageAsset | undefined => {
  const resource = field(payload, "resource");
  const tag = field(resource, "_tag");
  const attachmentId = field(resource, "attachmentId");
  const threadId = field(resource, "threadId");
  const itemId = field(resource, "itemId");
  if (tag === "attachment" && typeof attachmentId === "string") {
    return { kind: "attachment", attachmentId };
  }
  if (tag === "tool-output-image" && typeof threadId === "string" && typeof itemId === "string") {
    return { kind: "tool-output-image", threadId: ThreadId.make(threadId), itemId };
  }
  return undefined;
};

/**
 * The project a favicon request names by id. Upstream's client keys the request by the project's
 * folder, which a Viewer's client is given as a placeholder; the id rides where upstream carries
 * the path of a favicon override.
 */
const projectIconOf = (payload: unknown): ProjectId | undefined => {
  const resource = field(payload, "resource");
  return field(resource, "_tag") === "project-favicon"
    ? projectIdOfGuestIconPath(field(resource, "path"))
    : undefined;
};

const onThread = (level: PersonLevel): AccessRpcRule => ({
  kind: "thread",
  level,
  threadId: payloadThreadId,
});
const onProject = (level: PersonLevel): AccessRpcRule => ({
  kind: "project",
  level,
  projectId: payloadProjectId,
});
const collaborator: AccessRpcRule = { kind: "collaborator" };
const anyone: AccessRpcRule = { kind: "anyone" };
const serverHome: AccessRpcRule = { kind: "server" };
const narrowed: AccessRpcRule = { kind: "narrowed" };
const narrowedForAll: AccessRpcRule = { kind: "narrowed", unknownToo: true };

/**
 * Every WebSocket request a narrowed connection may make (the A1 table of the plan on #636). Keyed
 * by method so that a method upstream renames or removes fails to compile here. A method that is
 * absent is refused. Upstream's own permission check still runs on every request listed, so a
 * request that needs a permission the person's level does not give (settings, providers, access,
 * relay management, environment maintenance) is refused by upstream and is not listed.
 *
 * Left out on purpose, so refused to a narrowed connection: everything that lists or changes the
 * server as a whole (adding, cloning or importing projects, archived threads, searching every
 * thread, usage, diagnostics, pull request lists, peers, the relay); the inbox and the Crew reads,
 * until they read the person from the session; and Persona and skill writes.
 */
export const ACCESS_RPC_RULES: Partial<Record<WsRpcMethod, AccessRpcRule>> = {
  // A connection cannot start without these; each answers in a reduced form (`GuestView`).
  [WS_METHODS.serverGetConfig]: narrowedForAll,
  [WS_METHODS.subscribeServerConfig]: narrowedForAll,
  [WS_METHODS.subscribeServerLifecycle]: narrowedForAll,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: narrowedForAll,
  [WS_METHODS.serverProbe]: { ...anyone, unknownToo: true },
  // What a client reports of itself, and the policy it follows in the background.
  [WS_METHODS.serverReportClientActivity]: { ...anyone, unknownToo: true },
  [WS_METHODS.serverReportHostPowerState]: { ...anyone, unknownToo: true },
  [WS_METHODS.serverGetBackgroundPolicy]: { ...anyone, unknownToo: true },
  [WS_METHODS.subscribeBackgroundPolicy]: { ...anyone, unknownToo: true },

  // A thread and the agents beneath it (AC21). Its commands and its launch are checked command
  // by command (`CommandAdmission`).
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: narrowed,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: narrowed,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: onThread("viewer"),
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: onThread("collaborator"),
  [WS_METHODS.subscribeWorktreeSetup]: onThread("viewer"),
  [WS_METHODS.worktreeSetupCancel]: onThread("collaborator"),
  [WS_METHODS.assetsPersistChatAttachments]: onThread("collaborator"),
  [WS_METHODS.secretsAnswerRequest]: onThread("collaborator"),
  // The scheduled tasks bound to a thread or project the person reaches (`GuestView`), and a
  // Collaborator's changes to them there (AC20).
  [WS_METHODS.scheduledTasksList]: narrowed,
  [WS_METHODS.scheduledTasksSubscribe]: narrowed,
  [WS_METHODS.scheduledTasksUpsert]: { kind: "scheduledTask" },
  [WS_METHODS.scheduledTasksSetEnabled]: { kind: "scheduledTask" },
  [WS_METHODS.scheduledTasksRunNow]: { kind: "scheduledTask" },
  [WS_METHODS.scheduledTasksDelete]: { kind: "scheduledTask" },
  [WS_METHODS.scheduledTasksRotateWebhookToken]: { kind: "scheduledTask" },
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: { kind: "scheduledTask" },
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: { kind: "scheduledTask" },
  [WS_METHODS.providerUploadFeedback]: onThread("collaborator"),
  [WS_METHODS.mcpAppsToolInfo]: onThread("viewer"),
  [WS_METHODS.mcpAppsReadResource]: { kind: "mcpAppResource" },
  [WS_METHODS.mcpAppsCallTool]: onThread("collaborator"),
  [WS_METHODS.mcpAppsUpdateModelContext]: onThread("collaborator"),
  // Its preview tabs. A Viewer reads the list; driving a tab is writing.
  [WS_METHODS.previewList]: onThread("viewer"),
  [WS_METHODS.previewOpen]: onThread("collaborator"),
  [WS_METHODS.previewNavigate]: onThread("collaborator"),
  [WS_METHODS.previewResize]: onThread("collaborator"),
  [WS_METHODS.previewAdjust]: onThread("collaborator"),
  [WS_METHODS.previewRefresh]: onThread("collaborator"),
  [WS_METHODS.previewClose]: onThread("collaborator"),
  [WS_METHODS.previewReportStatus]: onThread("collaborator"),
  // Its terminals, by the thread they belong to, in any folder.
  [WS_METHODS.terminalOpen]: onThread("collaborator"),
  [WS_METHODS.terminalAttach]: onThread("collaborator"),
  [WS_METHODS.terminalObserve]: onThread("collaborator"),
  [WS_METHODS.terminalWrite]: onThread("collaborator"),
  [WS_METHODS.terminalResize]: onThread("collaborator"),
  [WS_METHODS.terminalClear]: onThread("collaborator"),
  [WS_METHODS.terminalRestart]: onThread("collaborator"),
  [WS_METHODS.terminalClose]: onThread("collaborator"),
  [WS_METHODS.deviceOpen]: onThread("collaborator"),
  [WS_METHODS.deviceClose]: onThread("collaborator"),

  // Files, git and the host's devices, keyed by a folder the client names: a Collaborator's.
  [WS_METHODS.projectsListEntries]: collaborator,
  [WS_METHODS.projectsReadFile]: collaborator,
  [WS_METHODS.projectsSearchContents]: collaborator,
  [WS_METHODS.projectsSearchEntries]: collaborator,
  [WS_METHODS.projectsWriteFile]: collaborator,
  [WS_METHODS.shellOpenInEditor]: collaborator,
  [WS_METHODS.filesystemBrowse]: collaborator,
  [WS_METHODS.filesystemGetMetadata]: collaborator,
  [WS_METHODS.attachmentsCreateUploadUrl]: collaborator,
  [WS_METHODS.attachmentsDelete]: collaborator,
  [WS_METHODS.subscribeVcsStatus]: collaborator,
  [WS_METHODS.vcsPull]: collaborator,
  [WS_METHODS.vcsRefreshStatus]: collaborator,
  [WS_METHODS.vcsListRefs]: collaborator,
  [WS_METHODS.vcsCreateWorktree]: collaborator,
  [WS_METHODS.vcsRemoveWorktree]: collaborator,
  [WS_METHODS.vcsCreateRef]: collaborator,
  [WS_METHODS.vcsSwitchRef]: collaborator,
  [WS_METHODS.vcsInit]: collaborator,
  [WS_METHODS.gitRunStackedAction]: collaborator,
  [WS_METHODS.gitResolvePullRequest]: collaborator,
  [WS_METHODS.gitPreparePullRequestThread]: collaborator,
  [WS_METHODS.reviewGetDiffPreview]: collaborator,
  [WS_METHODS.reviewGetDiffFileContents]: collaborator,
  [WS_METHODS.sourceControlLookupRepository]: collaborator,
  [WS_METHODS.sourceControlPublishRepository]: collaborator,
  [WS_METHODS.subscribeTerminalEvents]: collaborator,
  [WS_METHODS.subscribeTerminalMetadata]: collaborator,
  [WS_METHODS.subscribePreviewEvents]: collaborator,
  [WS_METHODS.previewClearProfile]: collaborator,
  [WS_METHODS.previewReportProfiles]: collaborator,
  [WS_METHODS.subscribeDiscoveredLocalServers]: collaborator,
  [WS_METHODS.deviceConfigure]: collaborator,
  [WS_METHODS.deviceList]: collaborator,
  [WS_METHODS.deviceTestHost]: collaborator,
  [WS_METHODS.deviceShutdown]: collaborator,
  [WS_METHODS.deviceDetail]: collaborator,
  [WS_METHODS.deviceAction]: collaborator,
  [WS_METHODS.subscribeDeviceState]: collaborator,
  [WS_METHODS.serverGetSettings]: collaborator,
  [WS_METHODS.serverRefreshProviders]: collaborator,
  // The images and files in a reachable thread's messages; the URL it returns is signed for
  // that one asset. A project's favicon, for a project in the person's sidebar, named by its id;
  // J5 answers that one itself (`GuestProjectIcons.ts`), since upstream's answer names the
  // project's folder.
  [WS_METHODS.assetsCreateUrl]: {
    kind: "messageAsset",
    asset: messageAssetOf,
    projectIcon: projectIconOf,
  },

  // A project as a whole (AC19, AC22): renaming and removing it, its artifacts, its Playbooks and
  // the skills in its workspace. Editing its scripts needs upstream's environment settings
  // permission, which only an Owner holds.
  [WS_METHODS.projectsMutate]: onProject("collaborator"),
  [J5_ARTIFACT_WS_METHODS.listArtifacts]: onProject("viewer"),
  [J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges]: onProject("viewer"),
  [J5_ARTIFACT_WS_METHODS.deleteArtifact]: onProject("collaborator"),
  [J5_PLAYBOOK_WS_METHODS.readLibrary]: onProject("viewer"),
  [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: onProject("viewer"),
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: onProject("collaborator"),
  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: onProject("collaborator"),
  [J5_SKILL_LINK_WS_METHODS.inspect]: onProject("viewer"),
  [J5_SKILL_LINK_WS_METHODS.preview]: onProject("collaborator"),
  [J5_SKILL_LINK_WS_METHODS.create]: onProject("collaborator"),
  [J5_SKILL_LINK_WS_METHODS.deletePreview]: onProject("collaborator"),
  [J5_SKILL_LINK_WS_METHODS.delete]: onProject("collaborator"),
  [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: onThread("viewer"),

  // The server's own surfaces (AC23), read by someone who holds a level at server scope.
  [J5_CLIENT_READ_WS_METHODS.readFleet]: serverHome,
  [J5_CLIENT_READ_WS_METHODS.listSpawnedChildren]: serverHome,
  [J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog]: serverHome,
  [J5_AGENT_PERSONA_WS_METHODS.readAgentPersona]: serverHome,
  [J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaUsage]: serverHome,
  [J5_SKILL_CATALOG_WS_METHODS.getSkillCatalogStatus]: serverHome,

  // Which J5 reads have moved, which says nothing of what changed; and agents' names, each only
  // for an agent the person may know.
  [J5_CLIENT_READ_WS_METHODS.readParticipantIdentities]: { kind: "identities" },
  [J5_CLIENT_READ_WS_METHODS.subscribeReadChanges]: anyone,

  // A connection asking what it holds, answered for its own session; saying whose a device is;
  // leaving what it holds (AC5, AC6, AC48).
  [J5_ACCESS_WS_METHODS.getConnectionAccess]: narrowedForAll,
  [J5_ACCESS_WS_METHODS.subscribeThreadLevel]: narrowedForAll,
  [J5_ACCESS_WS_METHODS.listClaimablePeople]: narrowedForAll,
  [J5_ACCESS_WS_METHODS.claimDevice]: narrowedForAll,
  [J5_ACCESS_WS_METHODS.setFirstOwnerName]: narrowed,
  [J5_ACCESS_WS_METHODS.leave]: narrowed,
  [J5_SHARING_WS_METHODS.getConnectionAccess]: narrowedForAll,
  [J5_SHARING_WS_METHODS.subscribeThreadAccess]: narrowed,
  [J5_SHARING_WS_METHODS.listOwnGrants]: narrowed,
  [J5_SHARING_WS_METHODS.leaveGrant]: narrowed,
  // Renaming oneself (AC46); who reaches a thread or project, by name and level (AC26); who
  // wrote what in a thread one reads.
  [J5_PEOPLE_WS_METHODS.renameSelf]: narrowed,
  [J5_PEOPLE_WS_METHODS.listScopePeople]: { kind: "scope", level: "viewer" },
  [J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges]: { kind: "scope", level: "viewer" },
  [J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors]: onThread("viewer"),
  [J5_SHARED_CONVERSATION_WS_METHODS.subscribeThreadAuthorsChanges]: onThread("viewer"),
  // Who else reaches a thread: their names and levels, no more (AC26).
  [J5_SHARING_WS_METHODS.listThreadPeople]: onThread("viewer"),
  [J5_SHARING_WS_METHODS.subscribeThreadPeopleChanges]: onThread("viewer"),
};

/**
 * `open`: the route decides for itself. `thread`: allowed when the person reaches the thread.
 * `projectInBody`: allowed when the person reaches the project the request's JSON body names.
 */
export type AccessHttpRule =
  | { readonly kind: "open" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "projectInBody" }
  | { readonly kind: "refuse" };

const THREAD_LOAD = /^\/api\/orchestration\/threads\/([^/]+)(?:\/(?:bounded|history))?$/;

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * Which HTTP routes keep a narrowed connection's permissions. `/ws` is the RPC socket, whose
 * requests `ACCESS_RPC_RULES` decides one by one. The sidebar snapshot route is refused: a client
 * that is refused it reads the sidebar from the socket's feed, which `GuestView` filters, so
 * there is one filtered path and not two. A route that reads no permission at all, such as the
 * one that issues a WebSocket ticket for the caller's own session, is unaffected and not listed.
 */
export const accessHttpRule = (method: string, pathname: string): AccessHttpRule => {
  // Reading one artifact of a project (AC22): a POST that changes nothing.
  if (method === "POST" && pathname === ARTIFACT_READ_PATH) return { kind: "projectInBody" };
  if (method !== "GET") return { kind: "refuse" };
  if (pathname === "/ws") return { kind: "open" };
  const threadLoad = THREAD_LOAD.exec(pathname);
  const threadId = threadLoad?.[1] === undefined ? undefined : decodeSegment(threadLoad[1]);
  return threadId === undefined || threadId.length === 0
    ? { kind: "refuse" }
    : { kind: "thread", threadId: ThreadId.make(threadId) };
};

const isServerAuthInternalError = Schema.is(EnvironmentAuth.ServerAuthInternalError);

const requestPathname = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://environment.invalid").pathname;

/**
 * Wraps upstream's `EnvironmentAuth`, through which every HTTP route and WebSocket upgrade signs a
 * request in, and through which every session is ended. A narrowed session comes back with its
 * permissions only on a route `accessHttpRule` allows, for a thread route only when the person
 * reaches that thread, and for an artifact read only when they reach the project its body names;
 * anywhere else it comes back with none, so the route's own permission check refuses it the way it
 * refuses any connection that lacks the permission. If what the person reaches cannot be read, they
 * get none.
 */
export const layerGatedEnvironmentAuth = Layer.effect(
  EnvironmentAuth.EnvironmentAuth,
  Effect.gen(function* () {
    const inner = yield* EnvironmentAuth.EnvironmentAuth;
    const access = yield* PersonAccess;
    const intents = yield* PairingIntents;
    const changes = yield* Access;
    // Upstream's own session store, to read whose browser is asking. A test that stands in for
    // upstream's auth has none, and then no browser is taken for anyone's.
    const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);

    const refuseUnreadable = (cause: unknown) =>
      Effect.logError("J5 access gate could not read what a person reaches; refusing", {
        cause,
      }).pipe(Effect.as(false));

    const gate = Effect.fn("j5.sharing.accessGate.http")(function* <
      S extends EnvironmentAuth.AuthenticatedSession,
    >(request: HttpServerRequest.HttpServerRequest, session: S) {
      const reach = yield* access
        .sessionReach(session)
        .pipe(Effect.catch((cause) => refuseUnreadable(cause).pipe(Effect.as(null))));
      if (reach !== null && isWide(reach)) return session;
      const rule = accessHttpRule(request.method, requestPathname(request));
      if (rule.kind === "open") return session;
      if (reach === null || reach.kind !== "person" || rule.kind === "refuse") {
        return { ...session, scopes: [] };
      }
      const personId = reach.person.personId;
      // The body is read once and kept, so the route reads the same bytes this check did.
      const held =
        rule.kind === "thread"
          ? access.threadLevel(personId, rule.threadId)
          : request.json.pipe(
              Effect.map(payloadProjectId),
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap((projectId) =>
                projectId === undefined
                  ? Effect.succeed(null)
                  : access.projectLevel(personId, ProjectId.make(projectId)),
              ),
            );
      const allowed = yield* held.pipe(
        Effect.map((level) => levelReaches(level, "viewer")),
        Effect.catch(refuseUnreadable),
      );
      return allowed ? session : { ...session, scopes: [] };
    });

    /**
     * Before upstream ends a session, by any of its four ways, the session is cut loose from its
     * person, and with that from any mark that would let it renew: an ended device stays ended
     * (AC49, AC50). If it cannot be done, nothing is revoked, so the Owner sees the failure and
     * the device is not left half ended.
     */
    const unbound = <A, E, R>(
      unbind: Effect.Effect<unknown, PersonAccessStorageError>,
      revoke: Effect.Effect<A, E, R>,
    ) =>
      unbind.pipe(
        Effect.mapError(
          (cause): EnvironmentAuth.ServerAuthInternalError =>
            new EnvironmentAuth.ServerAuthSessionRevocationError({ cause }),
        ),
        Effect.andThen(revoke),
      );

    /**
     * What to do about the session a browser already holds when it pairs again. Upstream replaces
     * that session with the new one, inside its session store, which matters twice over.
     *
     * A browser paired as one person opening a link made for another would become that other
     * person, so it is refused before upstream is called, and the link is not used up (AC32).
     *
     * Otherwise the browser is paired as upstream has it, and once upstream has done so, the old
     * session is cut loose from its person (`replaced`), since upstream revoked it. It is done
     * after upstream succeeds and not before: a browser that tries a link that does not work
     * keeps its session.
     *
     * A browser with no session costs nothing; one with a session costs a read of that session
     * and its binding, and a read of the credential's intent. If a read fails, the browser is
     * refused, since pairing it might move a device between people.
     */
    const previousSession = Effect.fn("j5.sharing.accessGate.previousSession")(
      function* (credential: string, previousSessionToken: string | undefined) {
        const pair = { decision: "pair" as const, replaced: undefined };
        if (previousSessionToken === undefined || Option.isNone(sessions)) return pair;
        // A session that has expired or been revoked is no one's.
        const previous = yield* Effect.option(sessions.value.verify(previousSessionToken));
        if (Option.isNone(previous)) return pair;
        // Upstream replaces a browser's cookie session, and no other kind.
        const replaced =
          previous.value.method === "browser-session-cookie" ? previous.value.sessionId : undefined;
        const reach = yield* access.sessionReach(previous.value);
        if (reach.kind !== "person") return { decision: "pair" as const, replaced };
        const intent = yield* intents.intentOf(credential);
        return intent !== null && intent.personId !== reach.person.personId
          ? { decision: "refuse" as const, replaced: undefined }
          : { decision: "pair" as const, replaced };
      },
      Effect.catch((cause) =>
        Effect.logError("J5 access gate could not read a browser's session; refusing to pair", {
          cause,
        }).pipe(Effect.as({ decision: "refuse" as const, replaced: undefined })),
      ),
    );

    return EnvironmentAuth.EnvironmentAuth.of({
      ...inner,
      createBrowserSession: (credential, requestMetadata, previousSessionToken) =>
        previousSession(credential, previousSessionToken).pipe(
          Effect.flatMap(({ decision, replaced }) =>
            decision === "refuse"
              ? // Refused before upstream is called, so the link is not used up.
                Effect.fail(
                  new EnvironmentAuth.ServerAuthInvalidCredentialError({
                    diagnostic: PAIRED_AS_SOMEONE_ELSE,
                  }),
                )
              : inner.createBrowserSession(credential, requestMetadata, previousSessionToken).pipe(
                  Effect.tap(() =>
                    replaced === undefined
                      ? Effect.void
                      : access.unbindSession(replaced).pipe(
                          // The browser is paired; the old session is revoked upstream either
                          // way. This is logged so a binding left behind can be found.
                          Effect.catch((cause) =>
                            Effect.logError(
                              "J5 access gate could not cut a replaced session loose",
                              {
                                cause,
                              },
                            ),
                          ),
                        ),
                  ),
                ),
          ),
        ),
      revokeSession: (sessionId) =>
        unbound(access.unbindSession(sessionId), inner.revokeSession(sessionId)),
      revokeOtherSessionsExcept: (sessionId) =>
        unbound(access.unbindOtherSessions(sessionId), inner.revokeOtherSessionsExcept(sessionId)),
      revokeClientSession: (currentSessionId, targetSessionId) =>
        currentSessionId === targetSessionId
          ? inner.revokeClientSession(currentSessionId, targetSessionId)
          : unbound(
              access.unbindSession(targetSessionId),
              inner.revokeClientSession(currentSessionId, targetSessionId),
            ),
      revokeOtherClientSessions: (currentSessionId) =>
        unbound(
          access.unbindOtherSessions(currentSessionId),
          inner.revokeOtherClientSessions(currentSessionId),
        ),
      // An MCP client is approved by an Owner; one approved before an Owner was lowered or
      // removed is refused its session, and approved again (`Access.issueMcpClient`). Upstream
      // issues one only from an exchange `McpApproval` gave the approval's generation to.
      issueMcpClientSession: (input) =>
        Effect.serviceOption(McpApprovalGeneration).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new StaleMcpApprovalError({})),
              onSome: (generation) =>
                changes.issueMcpClient(generation, inner.issueMcpClientSession(input)),
            }),
          ),
          Effect.mapError((cause) =>
            isServerAuthInternalError(cause)
              ? cause
              : new EnvironmentAuth.ServerAuthSessionTokenIssueError({ cause }),
          ),
        ),
      authenticateHttpRequest: (request) =>
        inner.authenticateHttpRequest(request).pipe(Effect.flatMap((s) => gate(request, s))),
      authenticateWebSocketUpgrade: (request) =>
        inner.authenticateWebSocketUpgrade(request).pipe(Effect.flatMap((s) => gate(request, s))),
    });
  }),
);

/**
 * Upstream's auth layer with the access gate in front of it, and beside it the services that
 * manage people and what they reach. `upstream` must also give `PersonAccess` and
 * `PairingIntents`, the same layers upstream's pairing code was built over
 * (`PairingIntents.peopleLayer`), and the database.
 */
export const gateEnvironmentAuth = <A, E, R>(
  upstream: Layer.Layer<
    | A
    | EnvironmentAuth.EnvironmentAuth
    | PersonAccess
    | PairingIntents
    | SessionStore.SessionStore
    | PairingGrantStore.PairingGrantStore,
    E,
    R
  >,
) =>
  peopleLayer.pipe(
    Layer.provideMerge(renewOutdatedDevicesAtStartup),
    Layer.provideMerge(layerGatedEnvironmentAuth),
    Layer.provideMerge(accessLayer),
    Layer.provideMerge(upstream),
  );

/**
 * Upstream's auth for the `j5` CLI, which builds its own rather than asking the running server:
 * ending a session from the CLI cuts it loose from its person too, so it can never renew, and the
 * CLI can record whose device a pairing link it makes is for.
 */
export const cliEnvironmentAuth = <E, R>(
  runtime: Layer.Layer<
    | EnvironmentAuth.EnvironmentAuth
    | SqlClient.SqlClient
    | SessionStore.SessionStore
    | PairingGrantStore.PairingGrantStore,
    E,
    R
  >,
) =>
  layerGatedEnvironmentAuth.pipe(
    Layer.provideMerge(accessLayer),
    Layer.provideMerge(peopleRecordsLayer),
    Layer.provideMerge(runtime),
  );

const notSharedError = () =>
  new EnvironmentAuthorizationError({
    message: "This is not shared with you on this server.",
    ...authScopeRequiredResponse(AuthOrchestrationReadScope),
  });

/**
 * The per-connection RPC authorization for `ws.ts`. A wide session gets upstream's own layer,
 * untouched. A narrowed one runs this first: a request must be in `ACCESS_RPC_RULES`, and must
 * name a thread or project the person reaches at the rule's level, or meet the rule's other
 * condition. Only then does upstream's permission check run, and a request still running is
 * ended if the person's reach changes so that it no longer meets its rule.
 *
 * Whether a session is wide is read when the socket opens. A change to what a person holds that
 * would change it renews their sessions, which closes this socket (`Access`).
 */
export const layerRpcAuthorization = (
  session: SessionIdentity,
  upstream: Layer.Layer<RpcScopeAuthorization>,
): Layer.Layer<RpcScopeAuthorization, never, PersonAccess> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const access = yield* PersonAccess;
      const reach = yield* access.sessionReach(session).pipe(
        Effect.catch((cause) =>
          Effect.logError("J5 access gate could not read whose a socket is; narrowing it", {
            cause,
          }).pipe(Effect.as({ kind: "unknown" } as SessionReach)),
        ),
      );
      if (isWide(reach)) return upstream;
      return Layer.effect(
        RpcScopeAuthorization,
        Effect.gen(function* () {
          const inner = yield* RpcScopeAuthorization;
          const refuseUnreadable = (cause: unknown) =>
            Effect.logError("J5 access gate could not read what a person reaches; refusing", {
              cause,
            }).pipe(Effect.as(false));

          /** Whether the rule still holds for this connection's person, read now. */
          const meets = (rule: AccessRpcRule, payload: unknown): Effect.Effect<boolean> => {
            if (reach.kind !== "person") return Effect.succeed(rule.unknownToo === true);
            const personId = reach.person.personId;
            switch (rule.kind) {
              case "narrowed":
              case "anyone":
              case "identities":
                return Effect.succeed(true);
              case "messageAsset":
                return Effect.succeed(true);
              case "collaborator":
                return access.listLevels(personId).pipe(
                  Effect.map((levels) =>
                    levels.some((held) => levelReaches(held.level, "collaborator")),
                  ),
                  Effect.catch(refuseUnreadable),
                );
              case "server":
                return access.listLevels(personId).pipe(
                  Effect.map((levels) => levels.some((held) => held.scope.kind === "server")),
                  Effect.catch(refuseUnreadable),
                );
              case "thread": {
                const threadId = rule.threadId(payload);
                if (threadId === undefined) return Effect.succeed(false);
                return access.threadLevel(personId, ThreadId.make(threadId)).pipe(
                  Effect.map((held) => levelReaches(held, rule.level)),
                  Effect.catch(refuseUnreadable),
                );
              }
              case "scheduledTask": {
                const atHome = (home: {
                  readonly projectId: string;
                  readonly threadId: string | null;
                }) =>
                  (home.threadId === null
                    ? access.projectLevel(personId, ProjectId.make(home.projectId))
                    : access.threadLevel(personId, ThreadId.make(home.threadId))
                  ).pipe(Effect.map((held) => levelReaches(held, "collaborator")));
                // The task an upsert addresses: its `id`, or the one upstream's service makes of a
                // `commandId` for an idempotent create (`ScheduledTaskService.upsert`).
                const commandId = stringField("commandId")(payload);
                const taskId =
                  stringField("id")(payload) ??
                  (commandId === undefined ? undefined : `scheduled-task:${commandId}`);
                const projectId = payloadProjectId(payload);
                const threadId = field(payload, "threadId");
                return Effect.gen(function* () {
                  if (taskId !== undefined) {
                    const home = yield* access.scheduledTaskHome(taskId);
                    // A task that does not exist yet is an upsert's new task, bound below.
                    if (home !== null && !(yield* atHome(home))) return false;
                    if (home === null && projectId === undefined) return false;
                  }
                  if (projectId === undefined) return taskId !== undefined;
                  return yield* atHome({
                    projectId,
                    threadId: typeof threadId === "string" ? threadId : null,
                  });
                }).pipe(Effect.catch(refuseUnreadable));
              }
              case "mcpAppResource": {
                const threadId = payloadThreadId(payload);
                const itemId = stringField("itemId")(payload);
                const uri = stringField("uri")(payload);
                if (threadId === undefined || itemId === undefined || uri === undefined) {
                  return Effect.succeed(false);
                }
                return access.threadLevel(personId, ThreadId.make(threadId)).pipe(
                  Effect.flatMap((held) =>
                    levelReaches(held, "collaborator")
                      ? Effect.succeed(true)
                      : !levelReaches(held, "viewer")
                        ? Effect.succeed(false)
                        : access
                            .mcpAppResource(ThreadId.make(threadId), itemId)
                            .pipe(Effect.map((published) => published === uri)),
                  ),
                  Effect.catch(refuseUnreadable),
                );
              }
              case "scope": {
                const scope = field(payload, "scope");
                const kind = field(scope, "kind");
                const id = field(scope, kind === "thread" ? "threadId" : "projectId");
                if (typeof id !== "string" || (kind !== "thread" && kind !== "project")) {
                  return Effect.succeed(false);
                }
                return (
                  kind === "thread"
                    ? access.threadLevel(personId, ThreadId.make(id))
                    : access.projectLevel(personId, ProjectId.make(id))
                ).pipe(
                  Effect.map((held) => levelReaches(held, rule.level)),
                  Effect.catch(refuseUnreadable),
                );
              }
              case "project": {
                const projectId = rule.projectId(payload);
                if (projectId === undefined) return Effect.succeed(false);
                return access.projectLevel(personId, ProjectId.make(projectId)).pipe(
                  Effect.map((held) => levelReaches(held, rule.level)),
                  Effect.catch(refuseUnreadable),
                );
              }
            }
          };

          return RpcScopeAuthorization.of((effect, options) => {
            const rule = ACCESS_RPC_RULES[options.rpc._tag as WsRpcMethod];
            if (rule === undefined) return Effect.fail(notSharedError());
            if (rule.kind === "identities") {
              if (reach.kind !== "person") return Effect.fail(notSharedError());
              const personId = reach.person.personId;
              // An agent the person may not know is told as unknown, as one with no name is.
              return inner(effect, options).pipe(
                Effect.flatMap((answered) => {
                  const response = answered as unknown as ParticipantIdentitiesResponse;
                  return Effect.forEach(response.entries, (entry) =>
                    entry.identity.kind !== "known"
                      ? Effect.succeed(entry)
                      : access
                          .participantVisible(personId, {
                            participantId: entry.participantId,
                            threadId: entry.identity.threadId ?? null,
                          })
                          .pipe(
                            Effect.catch(refuseUnreadable),
                            Effect.map((visible) =>
                              visible
                                ? entry
                                : { ...entry, identity: { kind: "unknown" as const } },
                            ),
                          ),
                  ).pipe(Effect.map((entries) => ({ entries }) as unknown as typeof answered));
                }),
              );
            }
            if (rule.kind === "messageAsset") {
              if (reach.kind !== "person") return Effect.fail(notSharedError());
              const personId = reach.person.personId;
              const projectId = rule.projectIcon(options.payload);
              if (projectId !== undefined) {
                // Upstream's handler is not run: its answer would carry the project's folder.
                // J5's own answer goes through upstream's permission check in its place.
                const answer = access.projectInFeed(personId, projectId).pipe(
                  Effect.catch(refuseUnreadable),
                  Effect.flatMap((inFeed) =>
                    inFeed ? issueGuestProjectIconUrl(projectId) : Effect.succeed(null),
                  ),
                  Effect.flatMap((link) =>
                    link === null ? Effect.fail(notSharedError()) : Effect.succeed(link),
                  ),
                );
                return inner(answer as unknown as typeof effect, options);
              }
              return access.listLevels(personId).pipe(
                Effect.flatMap((levels) => {
                  if (levels.some((held) => levelReaches(held.level, "collaborator"))) {
                    return Effect.succeed(true);
                  }
                  const asset = rule.asset(options.payload);
                  return asset === undefined
                    ? Effect.succeed(false)
                    : access
                        .messageAssetLevel(personId, asset)
                        .pipe(Effect.map((held) => levelReaches(held, "viewer")));
                }),
                Effect.catch(refuseUnreadable),
                Effect.flatMap((allowed) =>
                  allowed ? inner(effect, options) : Effect.fail(notSharedError()),
                ),
              );
            }
            return Effect.gen(function* () {
              // Subscribed before the first check, so no change between the two is missed.
              const reachChanges = yield* access.subscribeChanges;
              if (!(yield* meets(rule, options.payload))) return yield* notSharedError();
              // `effect` runs a streaming request to its end, so a feed opened while the rule held
              // would outlive it. It ends, refused as a new request would be, on the first change
              // to anyone's reach that leaves it unmet (AC12, AC49).
              const lostAccess = Stream.fromSubscription(reachChanges).pipe(
                Stream.mapEffect(() => meets(rule, options.payload)),
                Stream.filter((stillMeets) => !stillMeets),
                Stream.runHead,
                Effect.andThen(Effect.fail(notSharedError())),
              );
              return yield* Effect.raceFirst(inner(effect, options), lostAccess);
            });
          });
        }),
      ).pipe(Layer.provide(upstream));
    }),
  );
