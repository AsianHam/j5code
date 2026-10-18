import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as PersonAccess from "./PersonAccess.ts";
import {
  OTHER_PROJECT,
  PROJECT,
  accessLayer,
  person,
  placed,
  thread,
} from "./test-support/accessHarness.ts";

const sessionOf = (id: string, subject = "one-time-token") => ({
  sessionId: AuthSessionId.make(id),
  subject,
});

it.layer(accessLayer)("PersonAccess", (it) => {
  it.effect(
    "tells a person's device, the first owner's, a service's and an unknown one apart",
    () =>
      Effect.gen(function* () {
        const people = yield* PersonAccess.PersonAccess;
        const priya = yield* person("Priya", [{ scope: { kind: "server" }, level: "viewer" }]);
        yield* people.bindSession({
          sessionId: AuthSessionId.make("session:priya"),
          personId: priya.personId,
          ceiling: ["orchestration:read"],
        });

        const bound = yield* people.sessionReach(sessionOf("session:priya"));
        assert.strictEqual(bound.kind, "person");
        if (bound.kind === "person") {
          assert.strictEqual(bound.person.personId, priya.personId);
          assert.strictEqual(bound.serverLevel, "viewer");
          assert.deepStrictEqual(bound.ceiling, ["orchestration:read"]);
          // A server-scope Viewer is narrowed all the same: Viewers never see files (AC24).
          assert.isFalse(PersonAccess.isWide(bound));
        }

        // The startup link's and the desktop app's sessions are the first owner's (AC2).
        for (const subject of ["administrative-bootstrap", "desktop-bootstrap"]) {
          const reach = yield* people.sessionReach(sessionOf(`session:${subject}`, subject));
          assert.strictEqual(reach.kind, "person");
          if (reach.kind === "person") {
            assert.isTrue(reach.person.firstOwner);
            assert.strictEqual(reach.serverLevel, "owner");
            assert.isTrue(PersonAccess.isWide(reach));
          }
        }

        for (const subject of ["peer:environment-1", "mcp-client", "cli-issued-session"]) {
          const reach = yield* people.sessionReach(sessionOf(`session:${subject}`, subject));
          assert.strictEqual(reach.kind, "service");
        }

        // A Connections link made before its creator was recorded, or T3 Connect's, is no one's.
        const unknown = yield* people.sessionReach(sessionOf("session:cloud", "cloud-connect"));
        assert.strictEqual(unknown.kind, "unknown");
        assert.isFalse(PersonAccess.isWide(unknown));
      }),
  );

  it.effect("takes the highest level over a thread from the server, its project and above it", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const captain = yield* thread("thread:captain");
      const seat = yield* thread("thread:seat", OTHER_PROJECT);
      const subagent = yield* thread("thread:subagent", PROJECT, {
        parent: "thread:captain",
        relationship: "subagent",
      });
      const fork = yield* thread("thread:fork", PROJECT, {
        parent: "thread:captain",
        relationship: "fork",
      });
      yield* placed("thread:captain", null);
      yield* placed("thread:seat", "thread:captain");
      const other = yield* thread("thread:other");

      const sam = yield* person("Sam", [
        { scope: { kind: "thread", threadId: captain }, level: "collaborator" },
        { scope: { kind: "project", projectId: PROJECT }, level: "viewer" },
      ]);
      // The thread and the agents beneath it, in any project; not a fork (AC9).
      assert.strictEqual(yield* people.threadLevel(sam.personId, captain), "collaborator");
      assert.strictEqual(yield* people.threadLevel(sam.personId, subagent), "collaborator");
      assert.strictEqual(yield* people.threadLevel(sam.personId, seat), "collaborator");
      assert.strictEqual(yield* people.threadLevel(sam.personId, fork), "viewer");
      // Elsewhere in the project, the project's level (AC10, AC11).
      assert.strictEqual(yield* people.threadLevel(sam.personId, other), "viewer");
      assert.strictEqual(yield* people.projectLevel(sam.personId, PROJECT), "viewer");
      assert.strictEqual(yield* people.projectLevel(sam.personId, OTHER_PROJECT), null);
      // The seat's project is in the sidebar for the seat's sake, though its level is not held.
      assert.isTrue(yield* people.projectInFeed(sam.personId, OTHER_PROJECT));

      const maria = yield* person("Maria", [{ scope: { kind: "server" }, level: "owner" }]);
      assert.strictEqual(yield* people.threadLevel(maria.personId, seat), "owner");

      const reaching = yield* people.scopePeople({ kind: "thread", threadId: seat });
      const sams = reaching.find((entry) => entry.person.personId === sam.personId);
      assert.deepStrictEqual(sams?.via, [{ via: "ancestor", level: "collaborator" }]);
      assert.isTrue(reaching.some((entry) => entry.person.personId === maria.personId));
    }),
  );

  it.effect("keeps Owner at server scope and the first owner where they are", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const owner = yield* people.firstOwner;
      const lowered = yield* people
        .setLevel({ personId: owner.personId, scope: { kind: "server" }, level: "viewer" })
        .pipe(Effect.flip);
      assert.strictEqual(lowered._tag, "FirstOwnerFixedError");
      const removed = yield* people.removePerson(owner.personId).pipe(Effect.flip);
      assert.strictEqual(removed._tag, "FirstOwnerFixedError");

      const sam = yield* person("Sam B");
      const onProject = yield* people
        .setLevel({
          personId: sam.personId,
          scope: { kind: "project", projectId: PROJECT },
          level: "owner",
        })
        .pipe(Effect.flip);
      assert.strictEqual(onProject._tag, "OwnerOutsideServerError");
    }),
  );

  it.effect("removes what a person holds and keeps their record, freeing their name", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const contractor = yield* person("Contractor", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      yield* people.bindSession({
        sessionId: AuthSessionId.make("session:contractor"),
        personId: contractor.personId,
        ceiling: null,
      });

      const ended = yield* people.removePerson(contractor.personId);
      assert.deepStrictEqual(ended, [AuthSessionId.make("session:contractor")]);
      assert.isNull(yield* people.readPerson(contractor.personId));
      assert.strictEqual(
        (yield* people.sessionReach(sessionOf("session:contractor"))).kind,
        "unknown",
      );
      // Their messages keep the name they had (AC47); someone else may now take it (AC44).
      assert.deepStrictEqual(
        yield* sql`SELECT display_name FROM j5_a2a_human_person WHERE person_id = ${contractor.personId}`,
        [{ display_name: "Contractor" }],
      );
      yield* person("contractor");
      const taken = yield* person(" CONTRACTOR ").pipe(Effect.flip);
      assert.strictEqual(taken._tag, "PersonNameTakenError");
    }),
  );
});
