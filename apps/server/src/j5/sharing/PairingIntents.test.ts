import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";

import * as SessionStore from "../../auth/SessionStore.ts";
import { Access } from "./Access.ts";
import { J5_LINK_PAIRING_SUBJECT, PairingIntents } from "./PairingIntents.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { accessLayer, device, isLive, person } from "./test-support/accessHarness.ts";

it.layer(accessLayer)("PairingIntents", (it) => {
  it.effect("pairs a device as the person a credential was made for, with its ceiling", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const people = yield* PersonAccess.PersonAccess;
      const sessions = yield* SessionStore.SessionStore;
      const priya = yield* person("Priya", [{ scope: { kind: "server" }, level: "collaborator" }]);
      yield* intents.record({
        pairingLinkId: "pairing:priya",
        credential: "credential-priya",
        personId: priya.personId,
        linkId: null,
        ceiling: [AuthOrchestrationReadScope, "terminal:operate"],
      });

      // The credential carries both; the device asks for one.
      const issued = yield* intents.issueSession({
        grant: {
          subject: "one-time-token",
          scopes: [AuthOrchestrationReadScope, "terminal:operate"],
        },
        credential: "credential-priya",
        issue: sessions.issue({ scopes: [AuthOrchestrationReadScope] }),
      });
      const reach = yield* people.sessionReach({ sessionId: issued.sessionId, subject: "x" });
      assert.strictEqual(reach.kind === "person" ? reach.person.personId : null, priya.personId);
      // It asked for less than its ceiling, and keeps to what it asked for.
      assert.deepStrictEqual(reach.kind === "person" ? reach.ceiling : null, [
        AuthOrchestrationReadScope,
      ]);
      // The credential is used up.
      assert.isNull(yield* intents.intentOf("credential-priya"));
    }),
  );

  it.effect("pairs nothing from a credential that carries more than its person may hold now", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const sessions = yield* SessionStore.SessionStore;
      const sam = yield* person("Sam", [{ scope: { kind: "server" }, level: "viewer" }]);
      yield* intents.record({
        pairingLinkId: "pairing:sam",
        credential: "credential-sam",
        personId: sam.personId,
        linkId: null,
        ceiling: null,
      });
      const refused = yield* intents
        .issueSession({
          grant: { subject: "one-time-token", scopes: LEVEL_PERMISSIONS.collaborator },
          credential: "credential-sam",
          issue: sessions.issue({ scopes: LEVEL_PERMISSIONS.collaborator }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag === "PairingIntentError" ? refused.reason : null, "scopes");

      const retired = yield* intents
        .issueSession({
          grant: { subject: "j5:guest", scopes: [AuthOrchestrationReadScope] },
          credential: "an-old-share-link",
          issue: sessions.issue({ scopes: [AuthOrchestrationReadScope] }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(retired._tag === "PairingIntentError" ? retired.reason : null, "retired");
    }),
  );

  it.effect("never leaves a device paired while its person was lowered above its new level", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const access = yield* Access;
      const sessions = yield* SessionStore.SessionStore;
      const lead = yield* person("Lowered lead", [{ scope: { kind: "server" }, level: "owner" }]);
      yield* intents.record({
        pairingLinkId: "pairing:race",
        credential: "credential-race",
        personId: lead.personId,
        linkId: null,
        ceiling: null,
      });
      // The pairing is held open between its read of the level and its issue, and the level is
      // lowered in that gap.
      const gate = yield* Deferred.make<void>();
      const pairing = yield* Effect.forkChild(
        intents
          .issueSession({
            grant: { subject: "one-time-token", scopes: LEVEL_PERMISSIONS.owner },
            credential: "credential-race",
            issue: Deferred.await(gate).pipe(
              Effect.andThen(sessions.issue({ scopes: LEVEL_PERMISSIONS.owner })),
            ),
          })
          .pipe(Effect.result),
      );
      yield* Effect.yieldNow;
      const lowering = yield* Effect.forkChild(
        access.setLevel({ personId: lead.personId, scope: { kind: "server" }, level: "viewer" }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      const paired = yield* Fiber.join(pairing);
      yield* Fiber.join(lowering);
      // Either the lowering came first and the stale credential was refused, or the pairing did
      // and the lowering then ended the new device's session for renewal.
      if (Result.isSuccess(paired)) {
        assert.isFalse(yield* isLive(paired.success.sessionId));
      } else {
        assert.strictEqual(
          paired.failure._tag === "PairingIntentError" ? paired.failure.reason : null,
          "scopes",
        );
      }
    }),
  );

  it.effect("pairs nothing from a credential upstream took before its person was removed", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const access = yield* Access;
      const sessions = yield* SessionStore.SessionStore;
      // A Connections link made by an Owner, under Manage access.
      const leaving = yield* person("Leaving owner", [
        { scope: { kind: "server" }, level: "owner" },
      ]);
      yield* intents.record({
        pairingLinkId: "pairing:connections-taken",
        credential: "credential-connections-taken",
        personId: leaving.personId,
        linkId: null,
        ceiling: LEVEL_PERMISSIONS.owner,
      });
      // Upstream has taken the credential and is about to issue; the Owner is removed first.
      yield* access.removePerson(leaving.personId);
      const refused = yield* intents
        .issueSession({
          grant: { subject: "one-time-token", scopes: LEVEL_PERMISSIONS.owner },
          credential: "credential-connections-taken",
          issue: sessions.issue({ scopes: LEVEL_PERMISSIONS.owner }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(
        refused._tag === "PairingIntentError" ? refused.reason : null,
        "no_person",
      );
    }),
  );

  it.effect("pairs nothing from a J5 link's credential whose person is gone", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const sessions = yield* SessionStore.SessionStore;
      const refused = yield* intents
        .issueSession({
          grant: { subject: J5_LINK_PAIRING_SUBJECT, scopes: LEVEL_PERMISSIONS.viewer },
          credential: "credential-of-someone-removed",
          issue: sessions.issue({ scopes: LEVEL_PERMISSIONS.viewer }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(
        refused._tag === "PairingIntentError" ? refused.reason : null,
        "no_person",
      );
    }),
  );

  it.effect("lets only a code an Owner's level backs approve an MCP client", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const owner = yield* person("Owner two", [{ scope: { kind: "server" }, level: "owner" }]);
      const collaborator = yield* person("Collaborator", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      for (const [credential, personId] of [
        ["code-owner", owner.personId],
        ["code-collaborator", collaborator.personId],
      ] as const) {
        yield* intents.record({
          pairingLinkId: credential,
          credential,
          personId,
          linkId: null,
          ceiling: null,
        });
      }
      const grant = { subject: "one-time-token", scopes: LEVEL_PERMISSIONS.owner };
      assert.isTrue(yield* intents.approvesMcpClient(grant, "code-owner"));
      assert.isFalse(yield* intents.approvesMcpClient(grant, "code-collaborator"));
      // A J5 link's credential holds what its level gives, not what an Owner chose to hand out.
      assert.isFalse(
        yield* intents.approvesMcpClient(
          { subject: J5_LINK_PAIRING_SUBJECT, scopes: LEVEL_PERMISSIONS.collaborator },
          "code-from-a-link",
        ),
      );
      // A code with no person recorded is the server's own, as upstream issues it.
      assert.isTrue(yield* intents.approvesMcpClient(grant, "code-from-the-startup-link"));
    }),
  );

  it.effect("records a Connections link as its maker's, and records nothing for a service", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const maker = yield* person("Maker", [{ scope: { kind: "server" }, level: "owner" }]);
      const laptop = yield* device(maker.personId, LEVEL_PERMISSIONS.owner);
      yield* intents.recordForCreator({
        creator: laptop.identity,
        pairingLinkId: "pairing:connections",
        credential: "credential-connections",
        scopes: [AuthOrchestrationReadScope],
      });
      const intent = yield* intents.intentOf("credential-connections");
      assert.strictEqual(intent?.personId, maker.personId);
      assert.deepStrictEqual(intent?.ceiling, [AuthOrchestrationReadScope]);

      const peer = yield* device(null, [AuthOrchestrationReadScope], { subject: "peer:home" });
      yield* intents.recordForCreator({
        creator: peer.identity,
        pairingLinkId: "pairing:peer",
        credential: "credential-peer",
        scopes: [AuthOrchestrationReadScope],
      });
      assert.isNull(yield* intents.intentOf("credential-peer"));
    }),
  );
});
