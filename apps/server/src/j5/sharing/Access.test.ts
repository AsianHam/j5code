import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { Access } from "./Access.ts";
import { PairingIntents } from "./PairingIntents.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { makeSessionRenewal } from "./SessionRenewal.ts";
import {
  accessLayer,
  accessLayerWithHook,
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

  it.effect("revokes the links still waiting to pair a removed person's device", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const intents = yield* PairingIntents;
      const contractor = yield* person("Removed contractor", [
        { scope: { kind: "server" }, level: "viewer" },
      ]);
      const link = yield* grants.issueOneTimeToken({ scopes: LEVEL_PERMISSIONS.viewer });
      yield* intents.record({
        pairingLinkId: link.id,
        credential: link.credential,
        personId: contractor.personId,
        linkId: null,
        ceiling: null,
      });
      yield* access.removePerson(contractor.personId);
      assert.isFalse((yield* grants.listActive()).some((active) => active.id === link.id));
    }),
  );

  it.effect("tells a subscriber every change of a burst, however many", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const priya = yield* person("Priya in a burst");
      const told = yield* access.subscribe;
      for (let index = 0; index < 300; index += 1) {
        yield* access.rename({ personId: priya.personId, displayName: `Priya ${index}` });
      }
      assert.strictEqual((yield* PubSub.takeAll(told)).length, 300);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves MCP clients already issued alone when an Owner is lowered", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const maria = yield* person("Maria", [{ scope: { kind: "server" }, level: "owner" }]);
      const agent = yield* device(null, [AuthOrchestrationReadScope], { subject: "mcp-client" });

      yield* access.setLevel({
        personId: maria.personId,
        scope: { kind: "server" },
        level: "collaborator",
      });
      assert.isTrue(yield* isLive(agent.sessionId));
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
          subject: "one-time-token",
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
          subject: "one-time-token",
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

  it.effect("refuses an MCP session approved before an Owner was lowered or removed", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const sessions = yield* SessionStore.SessionStore;
      const owner = yield* person("Approving owner", [
        { scope: { kind: "server" }, level: "owner" },
      ]);
      const issueAgent = sessions.issue({
        subject: "mcp-client",
        scopes: [AuthOrchestrationReadScope],
      });
      const approvedNow = Effect.map(access.ownersGeneration, (generation) => ({
        generation,
        approver: owner.personId,
      }));
      yield* access.issueMcpClient(yield* approvedNow, issueAgent);

      // Approved, then the Owner is lowered, then the approval is exchanged: refused.
      const approved = yield* approvedNow;
      yield* access.setLevel({
        personId: owner.personId,
        scope: { kind: "server" },
        level: "viewer",
      });
      const stale = yield* access.issueMcpClient(approved, issueAgent).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "StaleMcpApprovalError");
      // One approved after the change issues, however soon.
      yield* access.issueMcpClient(yield* approvedNow, issueAgent);

      const other = yield* person("Owner who leaves", [
        { scope: { kind: "server" }, level: "owner" },
      ]);
      const beforeRemoval = { generation: yield* access.ownersGeneration, approver: null };
      yield* access.removePerson(other.personId);
      const removed = yield* access.issueMcpClient(beforeRemoval, issueAgent).pipe(Effect.flip);
      assert.strictEqual(removed._tag, "StaleMcpApprovalError");
    }),
  );

  it.effect("ends the MCP clients a lowered or removed Owner approved, and no one else's", () =>
    Effect.gen(function* () {
      const access = yield* Access;
      const sessions = yield* SessionStore.SessionStore;
      const owner = (name: string) => person(name, [{ scope: { kind: "server" }, level: "owner" }]);
      const approve = (approver: PersonAccess.Person | null) =>
        Effect.gen(function* () {
          const issued = yield* access.issueMcpClient(
            { generation: yield* access.ownersGeneration, approver: approver?.personId ?? null },
            sessions.issue({ subject: "mcp-client", scopes: [AuthOrchestrationReadScope] }),
          );
          return issued.sessionId;
        });
      const lowered = yield* owner("Owner who is lowered");
      const staying = yield* owner("Owner who stays");
      const removed = yield* owner("Owner who is removed");
      const loweredClient = yield* approve(lowered);
      const stayingClient = yield* approve(staying);
      const removedClient = yield* approve(removed);
      // Approved before approvers were recorded, or by a code that names no one.
      const unrecordedClient = yield* approve(null);
      const waiting = { generation: yield* access.ownersGeneration, approver: staying.personId };

      yield* access.setLevel({
        personId: lowered.personId,
        scope: { kind: "server" },
        level: "collaborator",
      });
      assert.isFalse(yield* isLive(loweredClient));
      assert.isTrue(yield* isLive(stayingClient));
      assert.isTrue(yield* isLive(removedClient));
      assert.isTrue(yield* isLive(unrecordedClient));
      // Still waiting when the Owners changed: refused, whoever approved it.
      const stale = yield* access
        .issueMcpClient(
          waiting,
          sessions.issue({ subject: "mcp-client", scopes: [AuthOrchestrationReadScope] }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(stale._tag, "StaleMcpApprovalError");

      yield* access.removePerson(removed.personId);
      assert.isFalse(yield* isLive(removedClient));
      assert.isTrue(yield* isLive(stayingClient));
      assert.isTrue(yield* isLive(unrecordedClient));
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

it.effect("runs the write hook inside a change, so a failing hook undoes the change", () =>
  Effect.gen(function* () {
    const access = yield* Access;
    const people = yield* PersonAccess.PersonAccess;
    const sam = yield* person("Hooked Sam");
    const failed = yield* access
      .setLevel({ personId: sam.personId, scope: { kind: "server" }, level: "viewer" })
      .pipe(Effect.flip);
    assert.strictEqual(failed._tag, "PersonAccessStorageError");
    assert.deepStrictEqual(yield* people.listLevels(sam.personId), []);
  }).pipe(
    Effect.provide(
      accessLayerWithHook({
        afterChange: () =>
          Effect.fail(new PersonAccess.PersonAccessStorageError({ operation: "record a writer" })),
      }),
    ),
  ),
);

const hooked: Array<string> = [];

it.effect("runs the write hook for a claimed device, a rename and a removal", () =>
  Effect.gen(function* () {
    const access = yield* Access;
    const kiosk = yield* device(null, LEVEL_PERMISSIONS.collaborator, {
      subject: "one-time-token",
    });
    const created = yield* access.claimDevice(
      { ...kiosk.identity, scopes: kiosk.scopes },
      { kind: "new", displayName: "Hooked kiosk" },
    );
    yield* access.rename({ personId: created, displayName: "Hooked kiosk two" });
    yield* access.removePerson(created);
    assert.deepStrictEqual(hooked, [created, created, created]);
  }).pipe(
    Effect.provide(
      accessLayerWithHook({
        afterChange: (personId) => Effect.sync(() => void hooked.push(personId)),
      }),
    ),
  ),
);
