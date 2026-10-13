import { assert, it } from "@effect/vitest";
import { AuthSessionId, ProjectId, ThreadId } from "@t3tools/contracts";
import { J5_SHARING_WS_METHODS, type SharingThreadAccess } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import {
  ensureLocalOperatorHumanPerson,
  isRegisteredHumanPerson,
  listRegisteredHumanPersonIds,
} from "../a2a/HumanPersonRegistry.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import * as PersonAccess from "./PersonAccess.ts";
import type { OpenLinks } from "./OpenLinks.ts";
import type { People } from "./People.ts";
import { makeSharingRpcHandlers } from "./sharingRpc.ts";

const AT = "2026-10-11T00:00:00.000Z";
/** The requests under test here answer from `PersonAccess` alone. */
const noPeople = {} as People["Service"];
const noOpenLinks = {} as OpenLinks["Service"];
const PROJECT = ProjectId.make("project:billing-migration");
const OTHER_PROJECT = ProjectId.make("project:website-redesign");

const testLayer = PersonAccess.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runJ5A2AMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
      }),
    ),
  ),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

type Lineage = { readonly parent: string; readonly relationship: "subagent" | "fork" } | null;

/** A thread in upstream's projection, with its lineage when it has a parent there. */
const thread = Effect.fn("test.thread")(function* (
  id: string,
  projectId: ProjectId = PROJECT,
  lineage: Lineage = null,
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({
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
const placed = Effect.fn("test.placed")(function* (
  id: string,
  under: string | null,
  provenance: "spawned-by" | "forked-from" | "unknown" = "spawned-by",
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
  const source = provenance === "unknown" ? null : under === null ? null : participant(under);
  yield* sql`
    INSERT INTO j5_a2a_participant_placement (
      project_id, participant_id, provenance_kind, provenance_participant_id, provenance_source,
      placement_parent_id, created_event_seq, updated_event_seq
    ) VALUES (
      ${PROJECT}, ${participant(id)}, ${source === null ? "unknown" : provenance}, ${source},
      ${source === null ? null : provenance === "forked-from" ? "upstream_lineage" : "j5_spawn"},
      ${under === null ? null : participant(under)}, 1, 1
    )
  `;
});

const guestSession = Effect.fn("test.guestSession")(function* (name: string) {
  const access = yield* PersonAccess.PersonAccess;
  const guest = yield* access.createGuest({ displayName: name });
  const sessionId = AuthSessionId.make(`session:${name}`);
  yield* access.bindSession({ sessionId, personId: guest.personId });
  return {
    guest,
    session: { sessionId, subject: PersonAccess.GUEST_SESSION_SUBJECT },
  };
});

it.layer(testLayer)("PersonAccess", (it) => {
  it.effect("a session with no person is a member's own device and reaches everything", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:member-device");
      const session = {
        sessionId: AuthSessionId.make("session:laptop"),
        subject: "one-time-token",
      };
      assert.strictEqual(yield* access.sessionPerson(session), null);
      assert.strictEqual(yield* access.threadAccess(session, threadId), "member");
      assert.strictEqual(yield* access.projectAccess(session, PROJECT), "member");
    }),
  );

  it.effect("a guest reaches nothing until a grant names it", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("no-grants");
      const threadId = yield* thread("thread:ungranted");
      assert.deepStrictEqual(yield* access.sessionPerson(session), guest);
      assert.strictEqual(yield* access.threadAccess(session, threadId), "none");
      assert.strictEqual(yield* access.projectAccess(session, PROJECT), "none");
    }),
  );

  it.effect("a session marked as a guest's with no person recorded reaches nothing", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:unbound-guest");
      const session = {
        sessionId: AuthSessionId.make("session:unbound-guest"),
        subject: PersonAccess.GUEST_SESSION_SUBJECT,
      };
      assert.strictEqual(yield* access.threadAccess(session, threadId), "none");
      assert.strictEqual(yield* access.projectAccess(session, PROJECT), "none");
    }),
  );

  it.effect("a thread grant gives its level on that thread and on no other", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("one-thread");
      const granted = yield* thread("thread:granted");
      const sibling = yield* thread("thread:sibling");
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: granted },
        level: "view",
      });
      assert.strictEqual(yield* access.threadAccess(session, granted), "view");
      assert.strictEqual(yield* access.threadAccess(session, sibling), "none");
      // A thread grant is not a grant on the project the thread lives in.
      assert.strictEqual(yield* access.projectAccess(session, PROJECT), "none");
    }),
  );

  it.effect("a thread grant covers the agents beneath the thread, however deep", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("tree");
      const captain = yield* thread("thread:captain");
      const seat = yield* thread("thread:seat");
      const seatChild = yield* thread("thread:seat-child");
      const subagent = yield* thread("thread:seat-subagent", PROJECT, {
        parent: "thread:seat",
        relationship: "subagent",
      });
      const moved = yield* thread("thread:moved-under");
      yield* placed("thread:captain", null);
      yield* placed("thread:seat", "thread:captain");
      yield* placed("thread:seat-child", "thread:seat");
      // An agent a person placed under the captain has no recorded spawner.
      yield* placed("thread:moved-under", "thread:captain", "unknown");
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: captain },
        level: "collaborate",
      });
      for (const covered of [captain, seat, seatChild, subagent, moved]) {
        assert.strictEqual(yield* access.threadAccess(session, covered), "collaborate", covered);
      }
    }),
  );

  it.effect("a grant on an agent does not reach up to the agent above it", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("upward");
      const parent = yield* thread("thread:parent");
      const child = yield* thread("thread:child");
      yield* placed("thread:parent", null);
      yield* placed("thread:child", "thread:parent");
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: child },
        level: "view",
      });
      assert.strictEqual(yield* access.threadAccess(session, child), "view");
      assert.strictEqual(yield* access.threadAccess(session, parent), "none");
    }),
  );

  it.effect("a fork of a granted thread is a thread of its own", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("fork");
      const source = yield* thread("thread:fork-source");
      const fork = yield* thread("thread:the-fork", PROJECT, {
        parent: "thread:fork-source",
        relationship: "fork",
      });
      const underFork = yield* thread("thread:under-the-fork");
      yield* placed("thread:fork-source", null);
      yield* placed("thread:the-fork", "thread:fork-source", "forked-from");
      yield* placed("thread:under-the-fork", "thread:the-fork");
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: source },
        level: "collaborate",
      });
      assert.strictEqual(yield* access.threadAccess(session, fork), "none");
      assert.strictEqual(yield* access.threadAccess(session, underFork), "none");
    }),
  );

  it.effect("a project grant covers every thread in the project and none outside it", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("project");
      const inside = yield* thread("thread:inside-project");
      const outside = yield* thread("thread:outside-project", OTHER_PROJECT);
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "project", projectId: PROJECT },
        level: "view",
      });
      assert.strictEqual(yield* access.projectAccess(session, PROJECT), "view");
      assert.strictEqual(yield* access.threadAccess(session, inside), "view");
      assert.strictEqual(yield* access.projectAccess(session, OTHER_PROJECT), "none");
      assert.strictEqual(yield* access.threadAccess(session, outside), "none");
    }),
  );

  it.effect("where a project grant and a thread grant overlap, the higher level applies", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("overlap");
      const raised = yield* thread("thread:raised");
      const plain = yield* thread("thread:plain");
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "project", projectId: PROJECT },
        level: "view",
      });
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: raised },
        level: "collaborate",
      });
      assert.strictEqual(yield* access.threadAccess(session, raised), "collaborate");
      assert.strictEqual(yield* access.threadAccess(session, plain), "view");
    }),
  );

  it.effect("putting a grant again changes its level, and removing it ends the access", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("change");
      const threadId = yield* thread("thread:changing");
      const target = { kind: "thread" as const, threadId };
      yield* access.putGrant({ personId: guest.personId, target, level: "view" });
      yield* access.putGrant({ personId: guest.personId, target, level: "collaborate" });
      assert.deepStrictEqual(yield* access.listGrants(guest.personId), [
        { personId: guest.personId, target, level: "collaborate", note: null },
      ]);
      assert.strictEqual(yield* access.threadAccess(session, threadId), "collaborate");
      yield* access.removeGrant({ personId: guest.personId, target });
      assert.strictEqual(yield* access.threadAccess(session, threadId), "none");
    }),
  );

  it.effect("a guest's client is told a different level on each thread it holds", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("mixed-levels");
      const reading = yield* thread("thread:mixed-view");
      const writing = yield* thread("thread:mixed-collaborate");
      const beneath = yield* thread("thread:mixed-collaborate-child", PROJECT, {
        parent: "thread:mixed-collaborate",
        relationship: "subagent",
      });
      const stranger = yield* thread("thread:mixed-ungranted");
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: reading },
        level: "view",
      });
      yield* access.putGrant({
        personId: guest.personId,
        target: { kind: "thread", threadId: writing },
        level: "collaborate",
      });
      const handlers = makeSharingRpcHandlers({
        access,
        people: noPeople,
        openLinks: noOpenLinks,
        session,
      });
      const told = (threadId: ThreadId) =>
        handlers[J5_SHARING_WS_METHODS.subscribeThreadAccess]({ threadId }).pipe(Stream.runHead);
      assert.deepStrictEqual(yield* handlers[J5_SHARING_WS_METHODS.getConnectionAccess](), {
        kind: "guest",
      });
      assert.deepStrictEqual(Option.getOrNull(yield* told(reading)), {
        kind: "guest",
        level: "view",
      });
      assert.deepStrictEqual(Option.getOrNull(yield* told(writing)), {
        kind: "guest",
        level: "collaborate",
      });
      // The agent beneath a granted thread carries its level; only the server can tell.
      assert.deepStrictEqual(Option.getOrNull(yield* told(beneath)), {
        kind: "guest",
        level: "collaborate",
      });
      assert.deepStrictEqual(Option.getOrNull(yield* told(stranger)), {
        kind: "guest",
        level: "none",
      });
    }),
  );

  it.effect("a client showing a thread is told when a grant changes its level", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const { guest, session } = yield* guestSession("level-changes");
      const other = yield* guestSession("level-bystander");
      const threadId = yield* thread("thread:level-changes");
      const target = { kind: "thread" as const, threadId };
      yield* access.putGrant({ personId: guest.personId, target, level: "view" });
      const told = yield* Queue.unbounded<SharingThreadAccess>();
      const handlers = makeSharingRpcHandlers({
        access,
        people: noPeople,
        openLinks: noOpenLinks,
        session,
      });
      yield* handlers[J5_SHARING_WS_METHODS.subscribeThreadAccess]({ threadId }).pipe(
        Stream.runForEach((item) => Queue.offer(told, item)),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(yield* Queue.take(told), { kind: "guest", level: "view" });
      // Another guest's grant, and a grant that leaves this level as it was, tell it nothing.
      yield* access.putGrant({ personId: other.guest.personId, target, level: "collaborate" });
      yield* access.putGrant({ personId: guest.personId, target, level: "view" });
      yield* access.putGrant({ personId: guest.personId, target, level: "collaborate" });
      assert.deepStrictEqual(yield* Queue.take(told), { kind: "guest", level: "collaborate" });
      yield* access.removeGrant({ personId: guest.personId, target });
      assert.deepStrictEqual(yield* Queue.take(told), { kind: "guest", level: "none" });
    }),
  );

  it.effect("a member's connection is told once that it is a member's", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:member-told-once");
      const session = { sessionId: AuthSessionId.make("session:desk"), subject: "one-time-token" };
      const handlers = makeSharingRpcHandlers({
        access,
        people: noPeople,
        openLinks: noOpenLinks,
        session,
      });
      // A member's connection is told the owner's name, or that there is none yet.
      assert.deepStrictEqual(yield* handlers[J5_SHARING_WS_METHODS.getConnectionAccess](), {
        kind: "member",
        ownerName: null,
      });
      yield* access.setOperatorName("Jackson Miller");
      assert.deepStrictEqual(yield* handlers[J5_SHARING_WS_METHODS.getConnectionAccess](), {
        kind: "member",
        ownerName: "Jackson Miller",
      });
      // A guest's connection is told it is a guest's, and nothing of the owner here.
      const guestHandlers = makeSharingRpcHandlers({
        access,
        people: noPeople,
        openLinks: noOpenLinks,
        session: { sessionId: session.sessionId, subject: PersonAccess.GUEST_SESSION_SUBJECT },
      });
      assert.deepStrictEqual(yield* guestHandlers[J5_SHARING_WS_METHODS.getConnectionAccess](), {
        kind: "guest",
      });
      // The feed ends after its one answer, so nothing stays open for a member.
      assert.deepStrictEqual(
        yield* handlers[J5_SHARING_WS_METHODS.subscribeThreadAccess]({ threadId }).pipe(
          Stream.runCollect,
        ),
        [{ kind: "member", level: "collaborate" }],
      );
    }),
  );

  it.effect("one guest's grant gives another guest nothing", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const first = yield* guestSession("first-guest");
      const second = yield* guestSession("second-guest");
      const threadId = yield* thread("thread:first-only");
      yield* access.putGrant({
        personId: first.guest.personId,
        target: { kind: "thread", threadId },
        level: "collaborate",
      });
      assert.strictEqual(yield* access.threadAccess(second.session, threadId), "none");
    }),
  );

  it.effect("a member holds no grants, and an unknown person cannot be given one", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const operator = yield* ensureLocalOperatorHumanPerson(sql);
      const threadId = yield* thread("thread:member-grant");
      const target = { kind: "thread" as const, threadId };
      const onMember = yield* Effect.flip(
        access.putGrant({ personId: operator, target, level: "view" }),
      );
      assert.strictEqual(onMember._tag, "GrantOnMemberError");
      const unknown = yield* Effect.flip(
        access.putGrant({
          personId: operator.replace(/.$/, "x") as typeof operator,
          target,
          level: "view",
        }),
      );
      assert.strictEqual(unknown._tag, "PersonNotFoundError");
    }),
  );

  it.effect("a guest is not someone an agent can ask and has no inbox here", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const operator = yield* ensureLocalOperatorHumanPerson(sql);
      const { guest } = yield* guestSession("not-addressable");
      assert.isTrue(yield* isRegisteredHumanPerson(sql, operator));
      assert.isFalse(yield* isRegisteredHumanPerson(sql, guest.personId));
      assert.notInclude(yield* listRegisteredHumanPersonIds(sql), guest.personId);
    }),
  );
});
