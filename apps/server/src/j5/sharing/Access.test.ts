import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { Access } from "./Access.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { makeSessionRenewal } from "./SessionRenewal.ts";
import {
  PROJECT,
  accessLayer,
  device,
  isLive,
  person,
  thread,
} from "./test-support/accessHarness.ts";

const renewal = Effect.gen(function* () {
  return makeSessionRenewal({
    sessions: yield* SessionStore.SessionStore,
    repository: yield* AuthSessionRepository,
    people: yield* PersonAccess.PersonAccess,
    sql: yield* SqlClient.SqlClient,
  });
});

it.layer(accessLayer)("Access", (it) => {
  it.effect(
    "ends a lowered person's sessions at once, and their device renews into the lower level",
    () =>
      Effect.gen(function* () {
        const access = yield* Access;
        const sessions = yield* SessionStore.SessionStore;
        const { renewToken } = yield* renewal;
        const lead = yield* person("Backup owner", [{ scope: { kind: "server" }, level: "owner" }]);
        const laptop = yield* device(lead.personId, LEVEL_PERMISSIONS.owner);
        // The socket open on the session: upstream ends it when the session is revoked.
        const socket = yield* Effect.forkChild(sessions.awaitInvalidation(laptop.sessionId));

        yield* access.setLevel({
          personId: lead.personId,
          scope: { kind: "server" },
          level: "collaborator",
        });
        yield* Fiber.join(socket);
        assert.isFalse(yield* isLive(laptop.sessionId));

        const renewed = yield* renewToken(laptop.token);
        assert.notStrictEqual(renewed, "live");
        if (renewed === "live") return;
        assert.deepStrictEqual([...renewed.scopes], [...LEVEL_PERMISSIONS.collaborator]);
        // Renewing never lengthens a device's life.
        assert.strictEqual(
          DateTime.toEpochMillis(renewed.expiresAt),
          DateTime.toEpochMillis(laptop.expiresAt),
        );
        const reach = yield* (yield* PersonAccess.PersonAccess).sessionReach({
          sessionId: renewed.sessionId,
          subject: "one-time-token",
        });
        assert.strictEqual(reach.kind === "person" ? reach.person.personId : null, lead.personId);

        // The same token presented again renews nothing.
        const again = yield* renewToken(laptop.token).pipe(Effect.flip);
        assert.strictEqual(again._tag, "NotRenewableError");
      }),
  );

  it.effect("renews a device whose permissions stay the same when its reach narrows", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const { renewToken } = yield* renewal;
      const threadId = yield* thread("thread:demoted");
      const sam = yield* person("Sam", [{ scope: { kind: "server" }, level: "collaborator" }]);
      // Paired from Connections with View environment alone: the same permissions at any level.
      const phone = yield* device(sam.personId, [AuthOrchestrationReadScope], {
        ceiling: [AuthOrchestrationReadScope],
      });

      yield* access.setLevel({
        personId: sam.personId,
        scope: { kind: "thread", threadId },
        level: "collaborator",
      });
      assert.isTrue(yield* isLive(phone.sessionId), "a scope added stays live");

      yield* access.removeLevel({ personId: sam.personId, scope: { kind: "server" } });
      assert.isFalse(yield* isLive(phone.sessionId), "narrowed from server to one thread");
      const renewed = yield* renewToken(phone.token);
      assert.notStrictEqual(renewed, "live");
      if (renewed !== "live") assert.deepStrictEqual(renewed.scopes, [AuthOrchestrationReadScope]);
    }),
  );

  it.effect("keeps an ended device ended, and renews no DPoP or expired session", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const people = yield* PersonAccess.PersonAccess;
      const sessions = yield* SessionStore.SessionStore;
      const { renewToken } = yield* renewal;
      const viewer = yield* person("Viewer", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);

      // Ended by an Owner: cut loose from its person, then revoked, as the gate does.
      const ended = yield* device(viewer.personId, LEVEL_PERMISSIONS.collaborator);
      yield* people.unbindSession(ended.sessionId);
      yield* sessions.revoke(ended.sessionId);
      assert.strictEqual(
        (yield* renewToken(ended.token).pipe(Effect.flip))._tag,
        "NotRenewableError",
      );

      const dpop = yield* device(viewer.personId, LEVEL_PERMISSIONS.collaborator, {
        method: "dpop-access-token",
      });
      const late = yield* device(viewer.personId, LEVEL_PERMISSIONS.collaborator);
      yield* access.setLevel({
        personId: viewer.personId,
        scope: { kind: "server" },
        level: "viewer",
      });
      assert.strictEqual(
        (yield* renewToken(dpop.token).pipe(Effect.flip))._tag,
        "NotRenewableError",
      );

      yield* TestClock.adjust(Duration.days(31));
      const expired = yield* renewToken(late.token).pipe(Effect.flip);
      assert.strictEqual(expired._tag, "NotRenewableError");
    }),
  );

  it.effect("renews a session once when its token is presented twice at the same moment", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const { renewToken } = yield* renewal;
      const priya = yield* person("Priya", [{ scope: { kind: "server" }, level: "collaborator" }]);
      const laptop = yield* device(priya.personId, LEVEL_PERMISSIONS.collaborator);
      yield* access.setLevel({
        personId: priya.personId,
        scope: { kind: "server" },
        level: "viewer",
      });

      const results = yield* Effect.all(
        [
          renewToken(laptop.token).pipe(Effect.result),
          renewToken(laptop.token).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      assert.strictEqual(results.filter(Result.isSuccess).length, 1);
    }),
  );

  it.effect("ends every MCP client when an Owner is lowered", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const maria = yield* person("Maria", [{ scope: { kind: "server" }, level: "owner" }]);
      const agent = yield* device(null, [AuthOrchestrationReadScope], { subject: "mcp-client" });
      const peer = yield* device(null, [AuthOrchestrationReadScope], { subject: "peer:home" });

      yield* access.setLevel({
        personId: maria.personId,
        scope: { kind: "project", projectId: PROJECT },
        level: "collaborator",
      });
      assert.isTrue(yield* isLive(agent.sessionId), "an Owner who only gained keeps them");

      yield* access.setLevel({
        personId: maria.personId,
        scope: { kind: "server" },
        level: "collaborator",
      });
      assert.isFalse(yield* isLive(agent.sessionId));
      assert.isTrue(yield* isLive(peer.sessionId));
    }),
  );

  it.effect(
    "lets a device no one claimed say whose it is, and never gives it more than it held",
    () =>
      Effect.gen(function* () {
        const access = yield* Access;
        const people = yield* PersonAccess.PersonAccess;
        const { renewToken } = yield* renewal;
        const owner = yield* people.firstOwner;
        const tablet = yield* device(null, [AuthOrchestrationReadScope], {
          subject: "cloud-connect",
        });
        assert.strictEqual((yield* people.sessionReach(tablet.identity)).kind, "unknown");

        yield* access.claimDevice(
          { ...tablet.identity, scopes: tablet.scopes },
          { kind: "person", personId: owner.personId },
        );
        const renewed = yield* renewToken(tablet.token);
        assert.notStrictEqual(renewed, "live");
        if (renewed !== "live")
          assert.deepStrictEqual(renewed.scopes, [AuthOrchestrationReadScope]);

        // A new name makes a person at server scope at the level the device's permissions suggest.
        const kiosk = yield* device(null, LEVEL_PERMISSIONS.collaborator, {
          subject: "cloud-connect",
        });
        const created = yield* access.claimDevice(
          { ...kiosk.identity, scopes: kiosk.scopes },
          { kind: "new", displayName: "Front desk" },
        );
        assert.deepStrictEqual(yield* people.listLevels(created), [
          { scope: { kind: "server" }, level: "collaborator" },
        ]);
      }),
  );

  it.effect("renews at startup every device whose permissions its level does not give", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const threadId = yield* thread("thread:migrated");
      const guest = yield* person("Migrated guest", [
        { scope: { kind: "thread", threadId }, level: "viewer" },
      ]);
      // What a guest's link gave every guest before levels: read, operate and preview.
      const browser = yield* device(guest.personId, [
        "orchestration:read",
        "orchestration:operate",
        "preview:operate",
      ]);
      const settled = yield* device(guest.personId, [AuthOrchestrationReadScope]);

      assert.strictEqual(yield* access.renewOutdatedDevices, 1);
      assert.isFalse(yield* isLive(browser.sessionId));
      assert.isTrue(yield* isLive(settled.sessionId));
    }),
  );
});
