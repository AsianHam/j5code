import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellStreamItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { subscribeOrchestrationV2Shell } from "../../ws.ts";
import * as GuestView from "./GuestView.ts";
import * as PersonAccess from "./PersonAccess.ts";

const AT = "2026-10-12T00:00:00.000Z";
const NOW = DateTime.makeUnsafe(AT);
const HOST_PATH = "/home/host/secret";
const HOST_ADDRESS = "100.64.12.7";

const session = (id: string, subject: string): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make(id),
  subject,
  method: "browser-session-cookie",
  scopes: [AuthOrchestrationReadScope],
});
const MEMBER = session("session:member", "one-time-token");
const GUEST = session("session:guest", PersonAccess.GUEST_SESSION_SUBJECT);
/** Carries the guest mark, and no person was ever recorded for it. */
const STRAY = session("session:stray", PersonAccess.GUEST_SESSION_SUBJECT);
const SESSIONS: Record<string, EnvironmentAuth.AuthenticatedSession> = {
  member: MEMBER,
  guest: GUEST,
  stray: STRAY,
};

// Real persistence and upstream's real feed; only the facades in front of them are stand-ins.
const layerPersistence = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerManagement = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
      readShellSnapshot: (options) =>
        projections.readShellSnapshot(options).pipe(Effect.map(Effect.orDie), Effect.orDie),
    });
  }),
);
const layerProjects = Layer.unwrap(
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const changes = yield* PubSub.unbounded<never>();
    return Layer.merge(
      Layer.mock(ProjectService.ProjectService)({
        getShell: (id) => projects.getShell(id).pipe(Effect.orDie),
      }),
      // Every root is resolved, so upstream sends its repository-identity frame, which names them.
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
        subscribeChanges: PubSub.subscribe(changes),
      }),
    );
  }),
);
const layerTest = Layer.mergeAll(layerManagement, layerProjects, PersonAccess.layer).pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(layerPersistence),
);

const project = Effect.fn("test.project")(function* (id: string) {
  const sink = yield* EventSink.EventSinkV2;
  const projectId = ProjectId.make(id);
  yield* sink.commitProjectCommand({
    commandId: CommandId.make(`create:${id}`),
    projectId,
    commandType: "project.create",
    acceptedAt: NOW,
    event: {
      eventId: EventId.make(`created:${id}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: AT,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: `Title of ${id}`,
        workspaceRoot: `${HOST_PATH}/${id}`,
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        scripts: [
          {
            id: "dev",
            name: "Dev",
            command: `${HOST_PATH}/run-dev`,
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
        createdAt: AT,
        updatedAt: AT,
      },
    },
  });
  return projectId;
});

const renameProject = Effect.fn("test.renameProject")(function* (
  id: ProjectId,
  title: string,
  icon: { readonly projectIcon?: unknown; readonly faviconPath?: string } = {},
) {
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.commitProjectCommand({
    commandId: CommandId.make(`rename:${id}:${title}`),
    projectId: id,
    commandType: "project.update",
    acceptedAt: NOW,
    event: {
      eventId: EventId.make(`renamed:${id}:${title}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: AT,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: { projectId: id, title, updatedAt: AT, ...icon } as never,
    },
  });
});

let eventCount = 0;
const threadEvent = (
  type: "thread.created" | "thread.metadata-updated",
  input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly title?: string;
    readonly parent?: ThreadId;
  },
): OrchestrationV2DomainEvent => {
  const id = ThreadId.make(input.id);
  return {
    id: EventId.make(`event:${++eventCount}`),
    type,
    threadId: id,
    occurredAt: NOW,
    payload: {
      id,
      projectId: input.projectId,
      title: input.title ?? input.id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "j5code/feature",
      worktreePath: `${HOST_PATH}/worktrees/${input.id}`,
      activeProviderThreadId: null,
      lineage:
        input.parent === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
          : {
              parentThreadId: input.parent,
              relationshipToParent: "subagent",
              rootThreadId: input.parent,
            },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};

/** Writes one thread event and returns the sequence number it was stored under. */
const write = Effect.fn("test.write")(function* (
  type: Parameters<typeof threadEvent>[0],
  input: Parameters<typeof threadEvent>[1],
) {
  const sink = yield* EventSink.EventSinkV2;
  const stored = yield* sink.write({ events: [threadEvent(type, input)] });
  return stored.at(-1)!.sequence;
});

/** A guest for `GUEST`'s session, holding the grants given. */
const guest = Effect.fn("test.guest")(function* (
  ...targets: ReadonlyArray<PersonAccess.GrantTarget>
) {
  const access = yield* PersonAccess.PersonAccess;
  const person = yield* access.createGuest({ displayName: "Contractor" });
  yield* access.bindSession({ sessionId: GUEST.sessionId, personId: person.personId });
  for (const target of targets) {
    yield* access.putGrant({ personId: person.personId, target, level: "view" });
  }
  return person.personId;
});

const upstreamShell = (input: Parameters<typeof subscribeOrchestrationV2Shell>[0]) =>
  Stream.unwrap(subscribeOrchestrationV2Shell(input));

/** Opens a connection's sidebar feed and queues what it is sent. */
const open = Effect.fn("test.open")(function* (
  who: EnvironmentAuth.AuthenticatedSession,
  input: Parameters<typeof subscribeOrchestrationV2Shell>[0] = { requestCompletionMarker: true },
) {
  const view = yield* GuestView.connectionView(who);
  const queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  yield* view.shellStream(input, upstreamShell).pipe(
    Stream.runForEach((item) => Queue.offer(queue, item)),
    Effect.forkScoped({ startImmediately: true }),
  );
  return queue;
});

/** Everything a feed sends up to and including the first item `done` accepts. */
const until = Effect.fn("test.until")(function* (
  queue: Queue.Queue<OrchestrationV2ShellStreamItem>,
  done: (item: OrchestrationV2ShellStreamItem) => boolean,
) {
  const items: Array<OrchestrationV2ShellStreamItem> = [];
  while (true) {
    const item = yield* Queue.take(queue);
    items.push(item);
    if (done(item)) return items;
  }
});
const synchronized = (item: OrchestrationV2ShellStreamItem) => item.kind === "synchronized";
const reached = (sequence: number) => (item: OrchestrationV2ShellStreamItem) =>
  "sequence" in item && item.sequence >= sequence;
const snapshotOf = (items: ReadonlyArray<OrchestrationV2ShellStreamItem>) => {
  const item = items.findLast((candidate) => candidate.kind === "snapshot");
  if (item?.kind !== "snapshot") throw new Error("No snapshot was sent");
  return item.snapshot;
};
/** The order and numbering of a feed, without its bodies. */
const outline = (items: ReadonlyArray<OrchestrationV2ShellStreamItem>) =>
  items.map((item) =>
    item.kind === "snapshot"
      ? `snapshot@${item.snapshot.snapshotSequence}`
      : "sequence" in item
        ? `${item.kind}@${item.sequence}`
        : item.kind,
  );

/**
 * The sidebar a connection is first sent. A guest's only source is the socket's feed: the HTTP
 * snapshot route is refused to it (`GuestGate.guestHttpRule`) and its client falls back here.
 */
const firstSnapshot = Effect.fn("test.firstSnapshot")(function* (who: keyof typeof SESSIONS) {
  return snapshotOf(yield* until(yield* open(SESSIONS[who]!), synchronized));
});

/** Each test gets its own database, so sequence numbers start from the same place in each. */
const live = <A, E>(
  name: string,
  test: Effect.Effect<A, E, Layer.Success<typeof layerTest> | import("effect/Scope").Scope>,
) => it.live(name, () => test.pipe(Effect.provide(layerTest)));

/** A provider with every field set, each host-specific one to a value the tests look for. */
const HOST_PROVIDER = {
  skillDiscoveryError: "host-skill-error",
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  accentColor: "host-accent",
  iconUrl: `http://${HOST_ADDRESS}/icon.png`,
  badgeLabel: "host-badge",
  continuation: { groupKey: "host-group" },
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  supportedRuntimeModes: ["full-access"],
  requiresNewThreadForModelChange: true,
  supportsConversationRollback: true,
  supportsTextGeneration: true,
  setup: { canAuthenticate: true, canInstall: true, documentationUrl: "https://host-docs" },
  nativeSessions: { canList: true, canLoad: true, canResume: true },
  configurableProviders: true,
  runtimePaths: { homePath: `${HOST_PATH}/codex-home`, shadowHomePath: null },
  enabled: true,
  installed: true,
  version: "9.9.9-host",
  status: "warning",
  auth: {
    status: "authenticated",
    type: "host-plan",
    label: "Host Account",
    email: "host@example.com",
    canLogout: true,
    profileId: "host-profile",
  },
  checkedAt: "2026-10-11T08:09:10.000Z",
  message: "host-status-message",
  availability: "available",
  models: [
    {
      slug: "gpt-test",
      name: "GPT Test",
      shortName: "Test",
      aliases: ["host-alias"],
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  updateRequiredModels: [{ slug: "gpt-next", name: "GPT Next", minVersion: "10.0.0-host" }],
  slashCommands: [{ name: "host-command" }],
  skills: [{ name: "host-skill", path: `${HOST_PATH}/skills/host-skill`, enabled: true }],
  workspaceSnapshots: [
    {
      cwd: `${HOST_PATH}/cwd`,
      checkedAt: "2026-10-11T08:09:10.000Z",
      slashCommands: [],
      skills: [],
    },
  ],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "9.9.9-host",
    latestVersion: "10.0.0-host",
    updateCommand: "host-update-command",
    canUpdate: true,
    checkedAt: null,
    message: null,
  },
  compatibilityAdvisory: {
    status: "graceful",
    message: "host-compatibility",
    recommendedVersion: null,
    recommendedRange: null,
  },
  updateState: {
    status: "failed",
    startedAt: null,
    finishedAt: null,
    message: "host-update-failed",
    output: "host-update-output",
  },
};

const fullConfig = {
  environment: {
    environmentId: EnvironmentId.make("environment:real"),
    label: "jackson-workstation",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.48",
    orchestrationProtocolVersion: 2,
    capabilities: { repositoryIdentity: true, j5HumanInbox: true, serverBrowser: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "t3_session",
  },
  cwd: `${HOST_PATH}/cwd`,
  keybindingsConfigPath: `${HOST_PATH}/keybindings.json`,
  keybindings: [{ command: "terminal.toggle", shortcut: { key: "j" } }],
  issues: [{ kind: "keybindings.malformed-config", message: `${HOST_PATH}/keybindings.json` }],
  providers: [HOST_PROVIDER, { ...HOST_PROVIDER, instanceId: "claude-off", enabled: false }],
  availableEditors: ["cursor"],
  remoteOpenTargets: [{ host: HOST_ADDRESS }],
  directEndpoints: [{ kind: "tailnet", httpBaseUrl: `http://${HOST_ADDRESS}:3773` }],
  observability: {
    logsDirectoryPath: `${HOST_PATH}/logs`,
    localTracingEnabled: true,
    otlpTracesUrl: `http://${HOST_ADDRESS}:4318`,
    otlpTracesEnabled: true,
    otlpMetricsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    worktreesDirectory: `${HOST_PATH}/worktrees`,
    branchNamePrefix: "host-prefix",
    github: { hosts: { "github.example.com": {} }, tokens: { "github.example.com": "••••••" } },
  },
  shellResumeCompletionMarker: true,
  threadFind: true,
  scratchWorkspaceRoot: `${HOST_PATH}/scratch`,
  newProjectsRoot: `${HOST_PATH}/projects`,
  environmentThemes: [{ name: "host-theme" }],
  usageLimitSources: [{ id: "host-source" }],
} as unknown as ServerConfig;

/** None of the host's paths, addresses, accounts or names survive in what a guest is sent. */
const assertNothingOfTheHost = (sent: unknown) => {
  const text = JSON.stringify(sent);
  for (const secret of [
    HOST_PATH,
    HOST_ADDRESS,
    "host@example.com",
    // Everything else a provider's entry says about the host's account, install and health.
    "Host Account",
    "host-plan",
    "host-profile",
    "9.9.9-host",
    "10.0.0-host",
    "host-status-message",
    "host-skill",
    "host-command",
    "host-alias",
    "host-accent",
    "host-badge",
    "host-group",
    "host-docs",
    "host-update",
    "host-compatibility",
    "2026-10-11T08:09:10.000Z",
    "claude-off",
    "host-prefix",
    // The server's own name is not in this list: its public descriptor gives it to anyone.
    "github.example.com",
    "host-theme",
    "host-source",
  ]) {
    assert.notInclude(text, secret);
  }
};

const encodeConfig = Schema.encodeEffect(ServerConfig);
const decodeConfig = Schema.decodeUnknownEffect(ServerConfig);

const collect = <A>(stream: Stream.Stream<A>) =>
  Stream.runCollect(stream).pipe(Effect.map((items) => Array.from(items)));

it.effect("a guest's configuration holds nothing of the host, and still decodes", () =>
  Effect.gen(function* () {
    const view = yield* GuestView.connectionView(GUEST);
    const reduced = view.config(fullConfig);
    assertNothingOfTheHost(reduced);
    // Each enabled provider is named, with its models, and says nothing else.
    assert.deepStrictEqual(reduced.providers, [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: "1970-01-01T00:00:00.000Z",
        models: [
          {
            slug: "gpt-test",
            name: "GPT Test",
            shortName: "Test",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ]);
    assert.strictEqual((yield* GuestView.connectionView(MEMBER)).config(fullConfig), fullConfig);
    assert.deepStrictEqual(reduced.settings, DEFAULT_SERVER_SETTINGS);
    assert.deepStrictEqual(reduced.environment, {
      environmentId: fullConfig.environment.environmentId,
      label: "jackson-workstation",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.48",
      orchestrationProtocolVersion: 2,
      capabilities: { repositoryIdentity: false, inlineMessageContext: true },
    });
    assert.deepStrictEqual(Object.keys(reduced).toSorted(), [
      "auth",
      "availableEditors",
      "cwd",
      "environment",
      "issues",
      "keybindings",
      "keybindingsConfigPath",
      "observability",
      "providers",
      "settings",
      "shellResumeCompletionMarker",
      "threadFind",
    ]);
    // What a client does with it: decode it against upstream's unchanged schema.
    const wire = JSON.parse(JSON.stringify(yield* encodeConfig(reduced)));
    assert.deepStrictEqual(yield* decodeConfig(wire), reduced);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("every later item on a guest's configuration feed is reduced or dropped", () =>
  Effect.gen(function* () {
    const updates = [
      { version: 1, type: "snapshot", config: fullConfig },
      { version: 1, type: "settingsUpdated", payload: { settings: fullConfig.settings } },
      { version: 1, type: "providerStatuses", payload: { providers: fullConfig.providers } },
      { version: 1, type: "keybindingsUpdated", payload: { keybindings: [], issues: [] } },
      { version: 1, type: "environmentThemesUpdated", payload: { themes: [] } },
      { version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } },
      // Upstream sends the whole configuration again once its editor scan finishes.
      { version: 1, type: "snapshot", config: { ...fullConfig, availableEditors: ["zed"] } },
    ] as unknown as ReadonlyArray<ServerConfigStreamEvent>;
    const feed = Stream.fromIterable(updates);

    const sent = yield* collect((yield* GuestView.connectionView(GUEST)).configStream(feed));
    assert.deepStrictEqual(
      sent.map((event) => event.type),
      ["snapshot", "snapshot"],
    );
    assertNothingOfTheHost(sent);
    for (const event of sent) {
      assert.deepStrictEqual(event.type === "snapshot" && event.config.availableEditors, []);
    }

    const member = yield* GuestView.connectionView(MEMBER);
    assert.strictEqual(member.configStream(feed), feed);
    assert.strictEqual(member.config(fullConfig), fullConfig);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a guest's lifecycle feed is a welcome that names nothing of the host", () =>
  Effect.gen(function* () {
    const events = [
      {
        version: 1,
        sequence: 1,
        type: "welcome",
        payload: {
          environment: fullConfig.environment,
          cwd: `${HOST_PATH}/cwd`,
          projectName: "host-prefix",
          bootstrapProjectId: ProjectId.make("project:bootstrap"),
          bootstrapThreadId: ThreadId.make("thread:bootstrap"),
        },
      },
      { version: 1, sequence: 2, type: "ready", payload: { at: AT, environment: {} } },
      {
        version: 1,
        sequence: 3,
        type: "legacyThreadMigration",
        payload: { status: "running", totalThreadCount: 412 },
      },
    ] as unknown as ReadonlyArray<ServerLifecycleStreamEvent>;
    const feed = Stream.fromIterable(events);

    const sent = yield* collect((yield* GuestView.connectionView(GUEST)).lifecycleStream(feed));
    assert.deepStrictEqual(sent, [
      {
        version: 1,
        sequence: 1,
        type: "welcome",
        payload: {
          environment: {
            environmentId: fullConfig.environment.environmentId,
            label: "jackson-workstation",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.48",
            orchestrationProtocolVersion: 2,
            capabilities: { repositoryIdentity: false, inlineMessageContext: true },
          },
          cwd: "/",
          projectName: "Shared project",
          bootstrapStatus: "complete",
        },
      },
    ]);

    assert.strictEqual((yield* GuestView.connectionView(MEMBER)).lifecycleStream(feed), feed);
  }).pipe(Effect.provide(layerTest)),
);

live(
  "a guest's sidebar holds only what its grants cover",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    const other = yield* project("project:other");
    yield* write("thread.created", { id: "thread:granted", projectId: shared });
    yield* write("thread.created", { id: "thread:sibling", projectId: shared });
    yield* write("thread.created", { id: "thread:elsewhere", projectId: other });
    yield* guest({ kind: "thread", threadId: ThreadId.make("thread:granted") });

    const expected = {
      projects: [
        {
          id: shared,
          title: "Title of project:shared",
          workspaceRoot: "/",
          // The project's id where a favicon's path would be; J5 serves the favicon by it.
          faviconPath: "j5-shared-project/project%3Ashared.png",
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      threads: ["thread:granted"],
    };
    const sent = yield* firstSnapshot("guest");
    assertNothingOfTheHost(sent);
    assert.deepStrictEqual(sent.projects, expected.projects);
    assert.deepStrictEqual(
      sent.threads.map((thread: { id: string }) => thread.id),
      expected.threads,
    );
    assert.strictEqual(sent.threads[0]?.worktreePath, "/");
    assert.strictEqual(sent.threads[0]?.branch, "j5code/feature");
    assert.deepStrictEqual(sent.archivedThreads, []);

    const first = yield* until(yield* open(GUEST), synchronized);
    assertNothingOfTheHost(first);
    // Upstream also sent a repository-identity frame naming every project's folder; a guest's
    // feed carries the one snapshot and the marker.
    assert.deepStrictEqual(outline(first), [`snapshot@${sent.snapshotSequence}`, "synchronized"]);
    assert.deepStrictEqual(snapshotOf(first), {
      ...sent,
      threads: snapshotOf(first).threads,
    });
    assert.deepStrictEqual(
      snapshotOf(first).threads.map((thread) => thread.id as string),
      expected.threads,
    );

    // A member's feed is upstream's own stream object.
    const untouched = Stream.empty;
    assert.strictEqual(
      (yield* GuestView.connectionView(MEMBER)).shellStream({}, () => untouched),
      untouched,
    );
  }).pipe(Effect.scoped),
);

live(
  "live changes reach a guest only for what is granted, numbered as a member sees them",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    const other = yield* project("project:other");
    const granted = ThreadId.make("thread:granted");
    yield* write("thread.created", { id: granted, projectId: shared });
    yield* write("thread.created", { id: "thread:sibling", projectId: shared });
    yield* guest({ kind: "thread", threadId: granted });

    const guestFeed = yield* open(GUEST);
    const memberFeed = yield* open(MEMBER);
    const guestStart = yield* until(guestFeed, synchronized);
    const memberStart = yield* until(memberFeed, synchronized);
    assert.strictEqual(
      snapshotOf(guestStart).snapshotSequence,
      snapshotOf(memberStart).snapshotSequence,
    );

    // Changes a guest must never hear of: an ungranted thread, a new thread, another project
    // (changed, then gone), each followed in the same feed by one it may.
    yield* write("thread.metadata-updated", {
      id: "thread:sibling",
      projectId: shared,
      title: "Sibling renamed",
    });
    yield* write("thread.created", { id: "thread:new", projectId: other });
    yield* renameProject(other, "Other renamed");
    yield* write("thread.metadata-updated", {
      id: granted,
      projectId: shared,
      title: "Granted renamed",
    });
    // A Subagent the granted thread runs is beneath it, so the grant covers it.
    const child = yield* write("thread.created", {
      id: "thread:child",
      projectId: shared,
      parent: granted,
    });
    // Its icon is chosen, and it has a favicon file somewhere on the host.
    yield* renameProject(shared, "Shared renamed", {
      projectIcon: { kind: "emoji", emoji: "🚀" },
      faviconPath: "/srv/host-favicon/icon.png",
    });
    const last = yield* write("thread.metadata-updated", {
      id: granted,
      projectId: shared,
      title: "Granted renamed again",
    });

    const guestLive = yield* until(guestFeed, reached(last));
    const memberLive = yield* until(memberFeed, reached(last));
    assertNothingOfTheHost(guestLive);
    assert.notInclude(JSON.stringify(guestLive), "thread:sibling");
    assert.notInclude(JSON.stringify(guestLive), "thread:new");
    assert.notInclude(JSON.stringify(guestLive), other);

    // Every item the guest got is one the member got, under the same number and in the same
    // order; the member's others are simply absent.
    const memberOutline = outline(memberLive);
    const guestOutline = outline(guestLive);
    assert.deepStrictEqual(
      memberOutline.filter((entry) => guestOutline.includes(entry)),
      guestOutline,
    );
    assert.isAbove(memberOutline.length, guestOutline.length);
    // Upstream folds one thread's changes within a moment into the newest, for both alike.
    assert.includeMembers(guestOutline, [`thread.updated@${child}`, `thread.updated@${last}`]);
    assert.strictEqual(guestOutline.filter((entry) => entry.startsWith("project.")).length, 1);
    const projectItem = guestLive.find((item) => item.kind === "project.updated");
    assert.deepStrictEqual(projectItem?.kind === "project.updated" && projectItem.project, {
      id: shared,
      title: "Shared renamed",
      workspaceRoot: "/",
      // The project's id where a favicon's path would be; J5 serves the favicon by it.
      faviconPath: "j5-shared-project/project%3Ashared.png",
      // The icon a person chose is plain data and is shown; the favicon's path is the host's.
      projectIcon: { kind: "emoji", emoji: "🚀" },
      defaultModelSelection: null,
      scripts: [],
      createdAt: AT,
      updatedAt: AT,
    });
    assert.notInclude(JSON.stringify(guestLive), "host-favicon");
    assert.include(JSON.stringify(memberLive), "host-favicon");
    for (const item of guestLive) {
      if (item.kind === "thread.updated") assert.strictEqual(item.thread.worktreePath, "/");
    }
  }).pipe(Effect.scoped),
);

live(
  "a grant given or removed while a guest is connected changes its feed without a reconnect",
  Effect.gen(function* () {
    const access = yield* PersonAccess.PersonAccess;
    const shared = yield* project("project:shared");
    const other = yield* project("project:other");
    const first = ThreadId.make("thread:first");
    const second = ThreadId.make("thread:second");
    yield* write("thread.created", { id: first, projectId: shared });
    yield* write("thread.created", { id: second, projectId: other });
    const personId = yield* guest({ kind: "thread", threadId: first });
    const isSnapshot = (item: OrchestrationV2ShellStreamItem) => item.kind === "snapshot";
    const listed = (items: ReadonlyArray<OrchestrationV2ShellStreamItem>) => ({
      threads: snapshotOf(items).threads.map((thread) => thread.id as string),
      projects: snapshotOf(items)
        .projects.map((entry) => entry.id as string)
        .toSorted(),
    });

    const feed = yield* open(GUEST);
    assert.deepStrictEqual(listed(yield* until(feed, synchronized)), {
      threads: [first],
      projects: [shared],
    });

    // Granted after connecting (AC10): the thread arrives, with its project.
    yield* access.putGrant({
      personId,
      target: { kind: "thread", threadId: second },
      level: "view",
    });
    const afterGrant = yield* until(feed, isSnapshot);
    assert.deepStrictEqual(listed(afterGrant), {
      threads: [first, second],
      projects: [other, shared],
    });
    assertNothingOfTheHost(afterGrant);

    // Removed (AC11): it leaves, and so does the project it alone made visible.
    yield* access.removeGrant({ personId, target: { kind: "thread", threadId: first } });
    assert.deepStrictEqual(listed(yield* until(feed, isSnapshot)), {
      threads: [second],
      projects: [other],
    });

    // The feed is still live after beginning again, and still filtered.
    yield* write("thread.metadata-updated", { id: first, projectId: shared, title: "Gone" });
    const renamed = yield* write("thread.metadata-updated", {
      id: second,
      projectId: other,
      title: "Still here",
    });
    assert.deepStrictEqual(outline(yield* until(feed, reached(renamed))), [
      `thread.updated@${renamed}`,
    ]);

    // Another guest's grants changing does not disturb this one's feed.
    const stranger = yield* access.createGuest({ displayName: "Someone else" });
    yield* access.putGrant({
      personId: stranger.personId,
      target: { kind: "thread", threadId: first },
      level: "view",
    });
    const again = yield* write("thread.metadata-updated", {
      id: second,
      projectId: other,
      title: "Once more",
    });
    assert.deepStrictEqual(outline(yield* until(feed, reached(again))), [
      `thread.updated@${again}`,
    ]);
  }).pipe(Effect.scoped),
);

live(
  "a project grant lists the project's threads, and the project even when it has none",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    const empty = yield* project("project:empty");
    const other = yield* project("project:other");
    yield* write("thread.created", { id: "thread:one", projectId: shared });
    yield* write("thread.created", { id: "thread:elsewhere", projectId: other });
    yield* guest({ kind: "project", projectId: shared }, { kind: "project", projectId: empty });

    const sent = yield* firstSnapshot("guest");
    assert.deepStrictEqual(sent.projects.map((entry: { id: string }) => entry.id).toSorted(), [
      empty,
      shared,
    ]);
    assert.deepStrictEqual(
      sent.threads.map((thread: { id: string }) => thread.id),
      ["thread:one"],
    );

    // A thread created in the granted project while connected is one the grant covers.
    const feed = yield* open(GUEST);
    yield* until(feed, synchronized);
    yield* write("thread.created", { id: "thread:elsewhere-2", projectId: other });
    const created = yield* write("thread.created", { id: "thread:two", projectId: shared });
    assert.deepStrictEqual(outline(yield* until(feed, reached(created))), [
      `thread.updated@${created}`,
    ]);
  }).pipe(Effect.scoped),
);

live(
  "a guest's feed begins from a snapshot even when its client asks to resume",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    const granted = ThreadId.make("thread:granted");
    yield* write("thread.created", { id: granted, projectId: shared });
    const before = yield* write("thread.created", { id: "thread:sibling", projectId: shared });
    yield* guest({ kind: "thread", threadId: granted });
    yield* write("thread.metadata-updated", {
      id: "thread:sibling",
      projectId: shared,
      title: "Sibling renamed",
    });
    const latest = yield* write("thread.metadata-updated", {
      id: granted,
      projectId: shared,
      title: "Granted renamed",
    });

    // A member resuming from `before` is replayed both renames; the guest gets a snapshot of
    // what it may see, at the same sequence the member ends on, then the same marker.
    const resume = { afterSequence: before, requestCompletionMarker: true };
    const member = yield* until(yield* open(MEMBER, resume), synchronized);
    assert.strictEqual(outline(member).at(-2), `thread.updated@${latest}`);
    const sent = yield* until(yield* open(GUEST, resume), synchronized);
    assert.deepStrictEqual(outline(sent), [`snapshot@${latest}`, "synchronized"]);
    assert.notInclude(JSON.stringify(sent), "thread:sibling");
    assertNothingOfTheHost(sent);

    // Without asking for the marker, none is sent: the first live item follows the snapshot.
    const unmarked = yield* open(GUEST, {});
    const start = yield* until(unmarked, (item) => item.kind === "snapshot");
    const next = yield* write("thread.metadata-updated", {
      id: granted,
      projectId: shared,
      title: "Granted renamed again",
    });
    assert.deepStrictEqual(outline(start), [`snapshot@${latest}`]);
    assert.deepStrictEqual(outline(yield* until(unmarked, reached(next))), [
      `thread.updated@${next}`,
    ]);
  }).pipe(Effect.scoped),
);

live(
  "a connection marked as a guest's with no person recorded is sent an empty sidebar",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    yield* write("thread.created", { id: "thread:one", projectId: shared });
    // Another guest holds everything; the stray session is not theirs.
    yield* guest({ kind: "project", projectId: shared });

    const sent = yield* firstSnapshot("stray");
    assert.deepStrictEqual(sent.projects, []);
    assert.deepStrictEqual(sent.threads, []);
    assert.deepStrictEqual(sent.archivedThreads, []);

    const feed = yield* open(STRAY);
    const first = yield* until(feed, synchronized);
    assert.deepStrictEqual(outline(first), [`snapshot@${sent.snapshotSequence}`, "synchronized"]);
    assert.deepStrictEqual(snapshotOf(first).threads, []);
    assert.deepStrictEqual(snapshotOf(first).projects, []);

    // Nothing live reaches it either: the next thing its feed holds is still nothing.
    const member = yield* open(MEMBER);
    yield* until(member, synchronized);
    const last = yield* write("thread.created", { id: "thread:two", projectId: shared });
    yield* until(member, reached(last));
    assert.strictEqual(yield* Queue.size(feed), 0);

    const view = yield* GuestView.connectionView(STRAY);
    assertNothingOfTheHost(view.config(fullConfig));
  }).pipe(Effect.scoped),
);

live(
  "a granted thread appearing in a project the client was not sent begins the feed again",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    const late = ThreadId.make("thread:late");
    // The grant names a thread that does not exist yet, so the first sidebar holds nothing.
    yield* guest({ kind: "thread", threadId: late });
    const feed = yield* open(GUEST);
    const first = yield* until(feed, synchronized);
    assert.deepStrictEqual(snapshotOf(first).projects, []);
    assert.deepStrictEqual(snapshotOf(first).threads, []);

    // The thread arrives as one item, but its project was never sent and two items cannot share
    // a sequence number: the guest is sent a whole sidebar holding both.
    yield* write("thread.created", { id: late, projectId: shared });
    const again = yield* until(
      feed,
      (item) => item.kind === "snapshot" && item.snapshot.threads.some(({ id }) => id === late),
    );
    assertNothingOfTheHost(again);
    assert.deepStrictEqual(
      again.map((item) => item.kind),
      ["snapshot"],
    );
    const sidebar = snapshotOf(again);
    assert.deepStrictEqual(
      sidebar.projects.map(({ id }) => id),
      [shared],
    );
    assert.deepStrictEqual(
      sidebar.threads.map(({ id }) => id),
      [late],
    );
  }).pipe(Effect.scoped),
);

live(
  "a grant that cannot be read ends a guest's feed with nothing sent",
  Effect.gen(function* () {
    const shared = yield* project("project:shared");
    yield* write("thread.created", { id: "thread:granted", projectId: shared });
    yield* guest({ kind: "thread", threadId: ThreadId.make("thread:granted") });
    const access = yield* PersonAccess.PersonAccess;
    const unreadable = PersonAccess.PersonAccess.of({
      ...access,
      threadAccess: () =>
        Effect.fail(
          new PersonAccess.PersonAccessStorageError({
            operation: "read a person's access to a thread",
          }),
        ),
    });
    const view = yield* GuestView.connectionView(GUEST).pipe(
      Effect.provideService(PersonAccess.PersonAccess, unreadable),
    );
    const sent: Array<OrchestrationV2ShellStreamItem> = [];
    const exit = yield* view.shellStream({ requestCompletionMarker: true }, upstreamShell).pipe(
      Stream.runForEach((item) => Effect.sync(() => sent.push(item))),
      Effect.exit,
    );
    // The feed fails rather than guessing: the thread the guest does hold is not sent either.
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(sent, []);
  }).pipe(Effect.scoped),
);
