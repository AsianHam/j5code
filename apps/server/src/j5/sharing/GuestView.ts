import {
  DEFAULT_SERVER_SETTINGS,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationProjectShell,
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { guestIconPath } from "./GuestProjectIcons.ts";
import { levelReaches } from "@t3tools/contracts/j5";

import {
  PersonAccess,
  type SessionIdentity,
  type SessionReach,
  isWide,
  reachPersonId,
} from "./PersonAccess.ts";

/**
 * What a guest's connection is told (Shared server AC12, AC23). A guest's client cannot connect
 * without the server configuration, the lifecycle welcome and the sidebar feed, so a guest gets
 * each in a reduced form: what a client needs to draw a granted thread, and none of the host's
 * paths, network addresses, provider accounts or settings. Its providers are named, with their
 * models, and nothing more. That holds outside the threads a guest
 * was granted. A granted thread's own contents are shared whole: its thread load and its feed
 * carry its worktree path and working directory, as its history already does. A member's
 * connection gets upstream's answer untouched; nothing here looks past the session's subject.
 */

/** Stands in for every host path a required field would otherwise carry. */
const PLACEHOLDER_PATH = "/";

const reduceEnvironment = (
  environment: ExecutionEnvironmentDescriptor,
): ExecutionEnvironmentDescriptor => ({
  environmentId: environment.environmentId,
  // The server's own name and platform, which its public descriptor
  // (`/.well-known/t3/environment`) gives anyone who can reach it. A person who is a guest of
  // two servers tells them apart by name.
  label: environment.label,
  platform: environment.platform,
  serverVersion: environment.serverVersion,
  ...(environment.orchestrationProtocolVersion === undefined
    ? {}
    : { orchestrationProtocolVersion: environment.orchestrationProtocolVersion }),
  capabilities: { repositoryIdentity: false },
});

/** What the read requests a guest may make can do; they say nothing about the host. */
const PROTOCOL_FLAGS = [
  "shellResumeCompletionMarker",
  "threadResumeCompletionMarker",
  "threadSnapshotPagination",
  "reasoningMessages",
  "threadFind",
  "threadFindProgressive",
] as const satisfies ReadonlyArray<keyof ServerConfig>;

/** When a reduced provider says it was checked: the schema needs a time, and the real one is the host's. */
const PLACEHOLDER_CHECKED_AT = "1970-01-01T00:00:00.000Z";

const reduceModel = (model: ServerProviderModel): ServerProviderModel => ({
  slug: model.slug,
  name: model.name,
  ...(model.shortName === undefined ? {} : { shortName: model.shortName }),
  ...(model.subProvider === undefined ? {} : { subProvider: model.subProvider }),
  isCustom: model.isCustom,
  ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
  ...(model.isLegacy === undefined ? {} : { isLegacy: model.isLegacy }),
  capabilities: model.capabilities,
});

/**
 * A provider as a guest's client is told of it: which one it is, what it is called and the models
 * it offers. Upstream's composer shows its "enable a provider" setup state when the list is empty,
 * and with these it shows a thread's model and, for a guest with View, its own read-only state.
 * Nothing of the provider's sign-in, version, health, paths, usage, skills or commands is sent:
 * each is left out or given its emptiest valid value. Built field by field, so a field upstream
 * adds later is left out until it is listed here.
 */
const reduceProvider = (provider: ServerProvider): ServerProvider => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: PLACEHOLDER_CHECKED_AT,
  models: provider.models.map(reduceModel),
  slashCommands: [],
  skills: [],
});

/** The providers a guest is told of: every one a thread could be running on, reduced. */
const reduceProviders = (providers: ServerConfig["providers"]) =>
  providers.filter((provider) => provider.enabled).map(reduceProvider);

/**
 * The configuration a guest's client is given. Built field by field, so a field upstream adds
 * later is left out until it is listed here.
 */
export const reduceServerConfig = (config: ServerConfig): ServerConfig => ({
  environment: reduceEnvironment(config.environment),
  auth: config.auth,
  cwd: PLACEHOLDER_PATH,
  keybindingsConfigPath: PLACEHOLDER_PATH,
  keybindings: [],
  issues: [],
  providers: reduceProviders(config.providers),
  availableEditors: [],
  observability: {
    logsDirectoryPath: PLACEHOLDER_PATH,
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  ...Object.fromEntries(
    PROTOCOL_FLAGS.flatMap((flag) => (config[flag] === undefined ? [] : [[flag, config[flag]]])),
  ),
});

/**
 * A project as a guest's client is told of it: enough to draw the thread under its project's name
 * and chosen icon. The icon a person chose (`projectIcon`: a named glyph, an emoji or a monogram)
 * is plain data and passes. A favicon file is asked for by the project's folder upstream, which a
 * guest is not told, so its path is replaced by one that names the project by id, and J5 serves
 * the file (`GuestProjectIcons.ts`).
 */
const reduceProject = (project: OrchestrationProjectShell): OrchestrationProjectShell => ({
  id: project.id,
  title: project.title,
  workspaceRoot: PLACEHOLDER_PATH,
  ...(project.projectIcon == null ? {} : { projectIcon: project.projectIcon }),
  // Not the host's path to a favicon: the project's id, for `GuestProjectIcons` to answer by.
  faviconPath: guestIconPath(project.id),
  defaultModelSelection: null,
  scripts: [],
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const reduceThread = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell =>
  thread.worktreePath === null ? thread : { ...thread, worktreePath: PLACEHOLDER_PATH };

type ShellSubscribeInput = {
  readonly afterSequence?: number;
  readonly requestCompletionMarker?: boolean;
};

/** How one connection is answered where a guest's answer differs from a member's. */
export interface ConnectionView {
  readonly config: (config: ServerConfig) => ServerConfig;
  readonly configStream: <E, R>(
    stream: Stream.Stream<ServerConfigStreamEvent, E, R>,
  ) => Stream.Stream<ServerConfigStreamEvent, E, R>;
  readonly lifecycleStream: <E, R>(
    stream: Stream.Stream<ServerLifecycleStreamEvent, E, R>,
  ) => Stream.Stream<ServerLifecycleStreamEvent, E, R>;
  /** `subscribe` is upstream's sidebar feed; a guest's is read through its grants. */
  readonly shellStream: <R>(
    input: ShellSubscribeInput,
    subscribe: (
      input: ShellSubscribeInput,
    ) => Stream.Stream<OrchestrationV2ShellStreamItem, OrchestrationV2GetShellSnapshotError, R>,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, OrchestrationV2GetShellSnapshotError, R>;
}

const MEMBER_VIEW: ConnectionView = {
  config: identity,
  configStream: identity,
  lifecycleStream: identity,
  shellStream: (input, subscribe) => subscribe(input),
};

/**
 * How a narrowed connection's sidebar is cut to what its person reaches. A Viewer's projects and
 * threads are reduced to what names nothing of the host; a Collaborator's keep their folders,
 * which their terminals and files open.
 */
const makeShellFilter = (access: PersonAccess["Service"], reach: SessionReach, reduce: boolean) => {
  const personId = reachPersonId(reach);
  const seesThread = (threadId: ThreadId) =>
    personId === null
      ? Effect.succeed(false)
      : access.threadLevel(personId, threadId).pipe(Effect.map((level) => level !== null));
  const holdsProject = (projectId: ProjectId) =>
    personId === null
      ? Effect.succeed(false)
      : access.projectLevel(personId, projectId).pipe(Effect.map((level) => level !== null));
  const project = reduce ? reduceProject : identity<OrchestrationProjectShell>;
  const thread = reduce ? reduceThread : identity<OrchestrationV2ThreadShell>;

  /** The threads a guest's grants cover, and the projects those threads or a grant name. */
  const snapshot = Effect.fn("j5.sharing.guestView.shellSnapshot")(function* (
    full: OrchestrationV2ShellSnapshot,
  ) {
    const threads = yield* Effect.filter(full.threads, (thread) => seesThread(thread.id));
    const threadProjects = new Set(threads.map((thread) => thread.projectId));
    const projects = yield* Effect.filter(full.projects, (project) =>
      threadProjects.has(project.id) ? Effect.succeed(true) : holdsProject(project.id),
    );
    return {
      schemaVersion: full.schemaVersion,
      snapshotSequence: full.snapshotSequence,
      projects: projects.map(project),
      threads: threads.map(thread),
      archivedThreads: [],
    } satisfies OrchestrationV2ShellSnapshot;
  });

  /**
   * One run of upstream's feed, read through the guest's grants. Sequence numbers and the
   * completion marker pass through as upstream sent them. `restart` asks for the feed to begin
   * again when a change cannot be told as one item.
   */
  const stream = <E, R>(
    upstream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
    restart: Effect.Effect<unknown>,
  ) =>
    Stream.suspend(() => {
      // What this run has told the client about, so a removal is only told for something sent.
      const threads = new Set<ThreadId>();
      const projects = new Set<ProjectId>();
      const pass = (item: OrchestrationV2ShellStreamItem) => [item];
      const drop: ReadonlyArray<OrchestrationV2ShellStreamItem> = [];
      return upstream.pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (item) {
            switch (item.kind) {
              case "synchronized":
                return pass(item);
              case "snapshot": {
                // A repository-identity refresh names host folders, and a guest's projects carry
                // no repository identity for it to fill in.
                if (item.resolvedRepositoryIdentityRoots !== undefined) return drop;
                const reduced = yield* snapshot(item.snapshot);
                threads.clear();
                projects.clear();
                for (const thread of reduced.threads) {
                  threads.add(thread.id);
                  projects.add(thread.projectId);
                }
                for (const project of reduced.projects) projects.add(project.id);
                return pass({ kind: "snapshot", snapshot: reduced });
              }
              case "thread.updated": {
                if (!threads.has(item.thread.id) && !(yield* seesThread(item.thread.id))) {
                  return drop;
                }
                if (!projects.has(item.thread.projectId)) {
                  // The client has not been given this thread's project, and two items cannot
                  // share a sequence number, so begin again from a snapshot that holds both.
                  yield* restart;
                  return drop;
                }
                threads.add(item.thread.id);
                return pass({ ...item, thread: thread(item.thread) });
              }
              case "thread.removed":
                return threads.delete(item.threadId) ? pass(item) : drop;
              case "project.updated": {
                if (!projects.has(item.project.id) && !(yield* holdsProject(item.project.id))) {
                  return drop;
                }
                projects.add(item.project.id);
                return pass({ ...item, project: project(item.project) });
              }
              case "project.removed":
                return projects.delete(item.projectId) ? pass(item) : drop;
            }
          }),
        ),
        Stream.flatMap((items) => Stream.fromIterable(items)),
      );
    });

  return { snapshot, stream };
};

const isShellFailure = Schema.is(OrchestrationV2GetShellSnapshotError);
const shellFailure = (cause: unknown) =>
  isShellFailure(cause)
    ? cause
    : new OrchestrationV2GetShellSnapshotError({
        message: "Failed to read what is shared with this guest",
        cause,
      });

const narrowedView = (access: PersonAccess["Service"], reach: SessionReach): ConnectionView => {
  // The configuration names the host's folders, network addresses, provider accounts and
  // settings. A Viewer is shown none of them (AC24); a Collaborator, who can open a terminal on
  // the host, is given upstream's.
  const writes =
    reach.kind === "person" &&
    reach.levels.some((held) => levelReaches(held.level, "collaborator"));
  const filter = makeShellFilter(access, reach, !writes);
  return {
    config: writes ? identity : reduceServerConfig,
    // Every later provider, settings, keybinding, theme and usage update is dropped rather than
    // reduced: a Viewer's client keeps the providers and models it was told of when it connected.
    configStream: writes
      ? identity
      : (stream) =>
          stream.pipe(
            Stream.filter((event) => event.type === "snapshot"),
            Stream.map((event) => ({ ...event, config: reduceServerConfig(event.config) })),
          ),
    // A client waits for the welcome before it draws anything. The other events report a server
    // update or a migration, which a narrowed connection neither starts nor is told about.
    lifecycleStream: (stream) =>
      stream.pipe(
        Stream.filter((event) => event.type === "welcome"),
        Stream.map((event) => ({
          version: event.version,
          sequence: event.sequence,
          type: event.type,
          payload: {
            environment: reduceEnvironment(event.payload.environment),
            cwd: PLACEHOLDER_PATH,
            projectName: "Shared project",
            bootstrapStatus: "complete" as const,
          },
        })),
      ),
    /**
     * A narrowed feed always begins from a full snapshot, the answer upstream already gives a
     * client whose cursor is too old to replay from, because what a replay may tell this
     * connection depends on what its client was sent before. It begins again, without the
     * client reconnecting, each time what the person reaches changes (AC10, AC12).
     */
    shellStream: (input, subscribe) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const personId = reachPersonId(reach);
          const reachChanges = yield* access.subscribeChanges;
          const restarts = yield* Queue.sliding<void>(1);
          const restart = Queue.offer(restarts, undefined);
          const begin = (marker: boolean) =>
            filter.stream(subscribe(marker ? { requestCompletionMarker: true } : {}), restart);
          return Stream.merge(
            Stream.fromQueue(restarts),
            Stream.fromSubscription(reachChanges).pipe(
              Stream.filter((changed) => changed === personId),
            ),
          ).pipe(
            Stream.as(false),
            (again) => Stream.concat(Stream.make(input.requestCompletionMarker === true), again),
            Stream.switchMap(begin),
          );
        }),
      ).pipe(Stream.mapError(shellFailure)),
  };
};

/**
 * The view for one WebSocket connection: upstream's own for a wide session, the narrowed one for
 * anyone else. Whose the session is is read once, when the socket opens; a change that would
 * alter it renews the session, which closes the socket (`Access`).
 */
export const connectionView = (
  session: SessionIdentity,
): Effect.Effect<ConnectionView, never, PersonAccess> =>
  Effect.gen(function* () {
    const access = yield* PersonAccess;
    const reach = yield* access
      .sessionReach(session)
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("J5 could not read whose a socket is; narrowing its view", {
            cause,
          }).pipe(Effect.as({ kind: "unknown" } as SessionReach)),
        ),
      );
    return isWide(reach) ? MEMBER_VIEW : narrowedView(access, reach);
  });
