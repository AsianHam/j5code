import {
  type AuthEnvironmentScope,
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  type ServerAuthSessionMethod,
  ThreadId,
} from "@t3tools/contracts";
import type { PersonLevel, PersonScope } from "@t3tools/contracts/j5";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as PairingGrantStore from "../../../auth/PairingGrantStore.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { humanPersonRegistryLayer } from "../../a2a/HumanPersonRegistry.ts";
import * as Access from "../Access.ts";
import * as Links from "../Links.ts";
import * as PairingIntents from "../PairingIntents.ts";
import * as People from "../People.ts";
import * as PersonAccess from "../PersonAccess.ts";

/**
 * People, their devices and upstream's real session store, over one in-memory database with
 * both migration lanes run, for the access core's tests.
 */

const AT = "2026-10-18T00:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const PROJECT = ProjectId.make("project:billing-migration");
export const OTHER_PROJECT = ProjectId.make("project:website-redesign");

const sessionStore = Layer.mergeAll(SessionStore.layer, PairingGrantStore.layer).pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j5-access-test-" })),
);

/** `PersonAccess`, `PairingIntents`, `Access` and `SessionStore` over one database. */
// The first owner, recorded as the server records them when it starts.
export const recordsLayer = PairingIntents.peopleLayer.pipe(
  Layer.provideMerge(humanPersonRegistryLayer),
  Layer.provideMerge(sessionStore),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

export const accessLayer = Access.layer.pipe(Layer.provideMerge(recordsLayer));

/** The same, with the people and links an Owner manages over it. */
export const peopleLayer = People.layer.pipe(
  Layer.provideMerge(Links.layer),
  Layer.provideMerge(accessLayer),
);

/** The same, with a hook run inside every change of what a person holds. */
export const accessLayerWithHook = (hook: Access.AccessWriteHook["Service"]) =>
  Access.layer.pipe(
    Layer.provide(Layer.succeed(Access.AccessWriteHook, hook)),
    Layer.provideMerge(recordsLayer),
  );

/** A thread in upstream's projection, with its lineage when it has a parent there. */
export const thread = Effect.fn("test.thread")(function* (
  id: string,
  projectId: ProjectId = PROJECT,
  lineage: { readonly parent: string; readonly relationship: "subagent" | "fork" } | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = encodeJson({
    lineage: {
      parentThreadId: lineage?.parent ?? null,
      relationshipToParent: lineage?.relationship ?? null,
      rootThreadId: lineage?.parent ?? id,
    },
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at,
      archived_at, deleted_at, payload_json
    ) VALUES (
      ${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default', NULL, ${AT}, ${AT},
      NULL, NULL, ${payload}
    )
  `;
  return ThreadId.make(id);
});

/** Registers a thread's agent in J5's ledger, placed under another agent when one is named. */
export const placed = Effect.fn("test.placed")(function* (
  id: string,
  under: string | null,
  provenance: "spawned-by" | "forked-from" = "spawned-by",
) {
  const sql = yield* SqlClient.SqlClient;
  const participant = (threadId: string) => `agent:j5:a2a:thread:${threadId}`;
  yield* sql`
    INSERT OR IGNORE INTO j5_a2a_project_ledger (project_id, created_at) VALUES (${PROJECT}, ${AT})
  `;
  yield* sql`
    INSERT INTO j5_a2a_membership (
      project_id, participant_id, participant_kind, thread_id, joined_seq, updated_seq, payload
    ) VALUES (${PROJECT}, ${participant(id)}, 'agent', ${id}, 1, 1, '{}')
  `;
  yield* sql`
    INSERT INTO j5_a2a_participant_placement (
      project_id, participant_id, provenance_kind, provenance_participant_id, provenance_source,
      placement_parent_id, created_event_seq, updated_event_seq
    ) VALUES (
      ${PROJECT}, ${participant(id)}, ${under === null ? "unknown" : provenance},
      ${under === null ? null : participant(under)},
      ${under === null ? null : provenance === "forked-from" ? "upstream_lineage" : "j5_spawn"},
      ${under === null ? null : participant(under)}, 1, 1
    )
  `;
});

/** A person with a name and the levels given, written directly. */
export const person = Effect.fn("test.person")(function* (
  name: string,
  levels: ReadonlyArray<{ readonly scope: PersonScope; readonly level: PersonLevel }> = [],
) {
  const people = yield* PersonAccess.PersonAccess;
  const created = yield* people.createPerson({ displayName: name });
  for (const held of levels) {
    yield* people.setLevel({ personId: created.personId, ...held });
  }
  return created;
});

/**
 * A device: a live session upstream issued with the permissions given, bound to the person, as
 * the issuer binds one.
 */
export const device = Effect.fn("test.device")(function* (
  personId: PersonAccess.Person["personId"] | null,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  options: {
    readonly method?: ServerAuthSessionMethod;
    readonly subject?: string;
    readonly ceiling?: ReadonlyArray<string> | null;
  } = {},
) {
  const sessions = yield* SessionStore.SessionStore;
  const people = yield* PersonAccess.PersonAccess;
  const issued = yield* sessions.issue({
    method: options.method ?? "browser-session-cookie",
    subject: options.subject ?? "one-time-token",
    scopes,
    ...(options.method === "dpop-access-token" ? { proofKeyThumbprint: "test-key" } : {}),
  });
  if (personId !== null) {
    yield* people.bindSession({
      sessionId: issued.sessionId,
      personId,
      ceiling: options.ceiling ?? null,
    });
  }
  return {
    ...issued,
    identity: { sessionId: issued.sessionId, subject: options.subject ?? "one-time-token" },
  };
});

/** Whether upstream still holds a session as live. */
export const isLive = Effect.fn("test.isLive")(function* (sessionId: AuthSessionId) {
  const sessions = yield* SessionStore.SessionStore;
  return (yield* sessions.listActive()).some((session) => session.sessionId === sessionId);
});

export const anySessionId = (name: string) => AuthSessionId.make(`session:${name}`);
