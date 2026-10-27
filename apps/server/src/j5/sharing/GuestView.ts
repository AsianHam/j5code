import {
  DEFAULT_SERVER_SETTINGS,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationProjectShell,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type ProjectId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ScheduledTaskListResult,
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
 * What a narrowed connection is told (AC24, AC25): config, lifecycle welcome and sidebar feed,
 * which its client needs. A Viewer gets them reduced, with no host paths, addresses, accounts or
 * settings. A Collaborator gets upstream's config and a sidebar cut to their reach. A thread in
 * reach is shared whole (worktree path too) but for the Owner's searches. Wide: upstream's.
 */

/** Stands in for every host path a required field would otherwise carry. */
const PLACEHOLDER_PATH = "/";

const reduceEnvironment = (
  environment: ExecutionEnvironmentDescriptor,
): ExecutionEnvironmentDescriptor => ({
  environmentId: environment.environmentId,
  // The server's own name and platform, which its public descriptor
  // (`/.well-known/t3/environment`) gives anyone who can reach it. A Viewer on two servers tells
  // them apart by name.
  label: environment.label,
  platform: environment.platform,
  serverVersion: environment.serverVersion,
  ...(environment.orchestrationProtocolVersion === undefined
    ? {}
    : { orchestrationProtocolVersion: environment.orchestrationProtocolVersion }),
  // That the server keeps J5's ledger says nothing of the host, and without it a client asks a
  // Viewer nothing J5 reads by project or thread: a thread's Playbook runs, the inbox, Crew asks.
  capabilities: {
    repositoryIdentity: false,
    ...(environment.capabilities.j5ProjectLedger === undefined
      ? {}
      : { j5ProjectLedger: environment.capabilities.j5ProjectLedger }),
  },
});

/** What the read requests a Viewer may make can do; they say nothing about the host. */
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
 * A skill as a Viewer is told of it: its name and what it is for, and none of its files (People
 * and access AC20, AC23). Built field by field, so a field upstream adds is left out.
 */
const reduceSkill = (skill: ServerProviderSkill): ServerProviderSkill => ({
  name: skill.name,
  ...(skill.description === undefined ? {} : { description: skill.description }),
  path: PLACEHOLDER_PATH,
  ...(skill.scope === undefined ? {} : { scope: skill.scope }),
  enabled: skill.enabled,
  ...(skill.displayName === undefined ? {} : { displayName: skill.displayName }),
  ...(skill.shortDescription === undefined ? {} : { shortDescription: skill.shortDescription }),
  ...(skill.userInvocationOnly === undefined
    ? {}
    : { userInvocationOnly: skill.userInvocationOnly }),
  ...(skill.userInvocable === undefined ? {} : { userInvocable: skill.userInvocable }),
});

/** Which of a provider's skills a Viewer is told of: all at server scope, a project's own at its. */
export type SkillsShown = (skill: ServerProviderSkill) => boolean;
const NO_SKILLS: SkillsShown = () => false;

/**
 * A provider as a Viewer's client is told of it: id, name and models, so upstream's composer shows
 * the thread's model rather than its setup state. Nothing of sign-in, version, health, paths or
 * usage; skills only via `reduceSkill`. Built field by field, so new upstream fields are left out.
 */
const reduceProvider = (provider: ServerProvider, skillsShown: SkillsShown): ServerProvider => ({
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
  skills: provider.skills.filter(skillsShown).map(reduceSkill),
});

/** The providers a Viewer is told of: every one a thread could be running on, reduced. */
const reduceProviders = (providers: ServerConfig["providers"], skillsShown: SkillsShown) =>
  providers
    .filter((provider) => provider.enabled)
    .map((provider) => reduceProvider(provider, skillsShown));

/**
 * The configuration a Viewer's client is given. Built field by field, so a field upstream adds
 * later is left out until it is listed here.
 */
export const reduceServerConfig = (
  config: ServerConfig,
  skillsShown: SkillsShown = NO_SKILLS,
): ServerConfig => ({
  environment: reduceEnvironment(config.environment),
  auth: config.auth,
  cwd: PLACEHOLDER_PATH,
  keybindingsConfigPath: PLACEHOLDER_PATH,
  keybindings: [],
  issues: [],
  providers: reduceProviders(config.providers, skillsShown),
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
 * A project as a Viewer's client is told of it: its name and chosen icon (`projectIcon` is plain
 * data). A favicon is requested by folder upstream, so its path becomes one naming the project by
 * id, and J5 serves the file (`GuestProjectIcons.ts`).
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

/**
 * A thread as any narrowed connection is told of it. `opens` holds the last Cmd+K queries that
 * picked the thread, which are the owner's searches (decision 6, 2026-10-24).
 */
const narrowThread = ({
  opens: _opens,
  ...thread
}: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => thread;

/** A thread as a Viewer's client is told of it: no folder of the host. */
const reduceThread = (shell: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => {
  const thread = narrowThread(shell);
  return thread.worktreePath === null ? thread : { ...thread, worktreePath: PLACEHOLDER_PATH };
};

/**
 * A thread's detail as any narrowed connection is told of it: no `opens`, as in its sidebar, and no
 * `guestShare`, upstream's guest link, which holds its guests' messages and the tunnel's host. J5
 * never sets it; it is dropped in case upstream ever does.
 */
const narrowAppThread = ({
  opens: _opens,
  guestShare: _guestShare,
  ...thread
}: OrchestrationV2AppThread): OrchestrationV2AppThread => thread;

const narrowProjection = (
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection => ({
  ...projection,
  thread: narrowAppThread(projection.thread),
});

type ThreadPayloadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

/** Read from the schema, so an event upstream adds that carries the whole thread is narrowed too. */
const THREAD_PAYLOAD_EVENTS: ReadonlySet<string> = new Set(
  OrchestrationV2DomainEvent.members.flatMap((member) => {
    if (member.fields.payload !== OrchestrationV2AppThread) return [];
    const type = member.fields.type;
    return "literals" in type ? type.literals : [type.literal];
  }),
);
const carriesThread = (event: OrchestrationV2DomainEvent): event is ThreadPayloadEvent =>
  THREAD_PAYLOAD_EVENTS.has(event.type);

const narrowThreadItem = (
  item: OrchestrationV2ThreadStreamItem,
): OrchestrationV2ThreadStreamItem => {
  if (item.kind === "snapshot") return { ...item, projection: narrowProjection(item.projection) };
  if (item.kind === "event" && carriesThread(item.event)) {
    return { ...item, event: { ...item.event, payload: narrowAppThread(item.event.payload) } };
  }
  return item;
};

type ShellSubscribeInput = {
  readonly afterSequence?: number;
  readonly requestCompletionMarker?: boolean;
};

/** How one connection is answered where a narrowed connection's answer differs from upstream's. */
export interface ConnectionView {
  /** The scheduled tasks a connection is listed: those bound to a thread or a project it reaches. */
  readonly scheduledTasks: <E, R>(
    list: Effect.Effect<ScheduledTaskListResult, E, R>,
  ) => Effect.Effect<ScheduledTaskListResult, E, R>;
  readonly scheduledTasksStream: <E, R>(
    stream: Stream.Stream<ScheduledTaskListResult, E, R>,
  ) => Stream.Stream<ScheduledTaskListResult, E, R>;
  readonly config: (config: ServerConfig) => ServerConfig;
  readonly configStream: <E, R>(
    stream: Stream.Stream<ServerConfigStreamEvent, E, R>,
  ) => Stream.Stream<ServerConfigStreamEvent, E, R>;
  readonly lifecycleStream: <E, R>(
    stream: Stream.Stream<ServerLifecycleStreamEvent, E, R>,
  ) => Stream.Stream<ServerLifecycleStreamEvent, E, R>;
  /** `subscribe` is upstream's sidebar feed, read through what a narrowed person reaches. */
  readonly shellStream: <R>(
    input: ShellSubscribeInput,
    subscribe: (
      input: ShellSubscribeInput,
    ) => Stream.Stream<OrchestrationV2ShellStreamItem, OrchestrationV2GetShellSnapshotError, R>,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, OrchestrationV2GetShellSnapshotError, R>;
  /** Upstream's thread-detail feed: its snapshot and every event that carries the thread. */
  readonly threadStream: <E, R>(
    stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
  ) => Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>;
  /** Upstream's one-shot thread load, the same detail without the feed. */
  readonly threadProjection: <E, R>(
    load: Effect.Effect<OrchestrationV2ThreadProjection, E, R>,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, E, R>;
}

const MEMBER_VIEW: ConnectionView = {
  scheduledTasks: identity,
  scheduledTasksStream: identity,
  config: identity,
  configStream: identity,
  lifecycleStream: identity,
  shellStream: (input, subscribe) => subscribe(input),
  threadStream: identity,
  threadProjection: identity,
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
  const thread = reduce ? reduceThread : narrowThread;

  /** The threads a person reaches, and the projects those threads or a level name. */
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
   * One run of upstream's feed, read through what the person reaches. Sequence numbers and the
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
                // A repository-identity refresh names host folders, and a narrowed sidebar's projects carry
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
        message: "Failed to read what is shared with this person",
        cause,
      });

const narrowedView = (
  access: PersonAccess["Service"],
  reach: SessionReach,
  skillsShown: SkillsShown,
): ConnectionView => {
  // The configuration names the host's folders, network addresses, provider accounts and
  // settings. A Viewer is shown none of them (AC24); a Collaborator, who can open a terminal on
  // the host, is given upstream's.
  const writes =
    reach.kind === "person" &&
    reach.levels.some((held) => levelReaches(held.level, "collaborator"));
  const filter = makeShellFilter(access, reach, !writes);
  const personId = reachPersonId(reach);
  /**
   * A task bound to a thread is at home there; any other is its project's (AC21, AC22). A task's
   * webhook address starts it, so it is given only to someone who writes where the task is at
   * home, whatever they write elsewhere. A task that cannot be checked is left out.
   */
  const reachableTasks = (result: ScheduledTaskListResult) =>
    Effect.forEach(result.tasks, (task) =>
      personId === null
        ? Effect.succeed([])
        : (task.threadId === null
            ? access.projectLevel(personId, task.projectId)
            : access.threadLevel(personId, task.threadId)
          ).pipe(
            Effect.map((level) => {
              if (level === null) return [];
              if (levelReaches(level, "collaborator")) return [task];
              const { webhook: _webhook, ...shown } = task;
              return [shown];
            }),
            Effect.orElseSucceed(() => []),
          ),
    ).pipe(Effect.map((tasks) => ({ tasks: tasks.flat() })));
  return {
    scheduledTasks: (list) => list.pipe(Effect.flatMap(reachableTasks)),
    scheduledTasksStream: (stream) => stream.pipe(Stream.mapEffect(reachableTasks)),
    config: writes ? identity : (config) => reduceServerConfig(config, skillsShown),
    // Every later provider, settings, keybinding, theme and usage update is dropped rather than
    // reduced: a Viewer's client keeps the providers and models it was told of when it connected.
    configStream: writes
      ? identity
      : (stream) =>
          stream.pipe(
            Stream.filter((event) => event.type === "snapshot"),
            Stream.map((event) => ({
              ...event,
              config: reduceServerConfig(event.config, skillsShown),
            })),
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
    threadStream: (stream) => stream.pipe(Stream.map(narrowThreadItem)),
    threadProjection: (load) => load.pipe(Effect.map(narrowProjection)),
  };
};

/**
 * The view for one WebSocket connection: upstream's own for a wide session, the narrowed one for
 * anyone else. Whose the session is is read once, when the socket opens; a change that would
 * alter it renews the session, which closes the socket (`Access`).
 */
export const connectionView = Effect.fn("j5.sharing.guestView.connectionView")(function* (
  session: SessionIdentity,
): Effect.fn.Return<ConnectionView, never, PersonAccess> {
  const access = yield* PersonAccess;
  const reach = yield* access.sessionReach(session).pipe(
    Effect.catch((cause) =>
      Effect.logError("J5 could not read whose a socket is; narrowing its view", {
        cause,
      }).pipe(Effect.as({ kind: "unknown" } as SessionReach)),
    ),
  );
  if (isWide(reach)) return MEMBER_VIEW;
  // A Viewer at server scope is told every provider's skills; one at a project, the skills in
  // that project's own folders; anyone else, none.
  const roots =
    reach.kind !== "person"
      ? []
      : reach.levels.some((held) => held.scope.kind === "server")
        ? null
        : yield* access
            .projectRoots(reach.person.personId)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const skillsShown: SkillsShown =
    roots === null
      ? () => true
      : (skill) => roots.some((root) => skill.path.startsWith(`${root.replace(/\/+$/u, "")}/`));
  return narrowedView(access, reach, skillsShown);
});
