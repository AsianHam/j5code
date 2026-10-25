import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { Access } from "./Access.ts";
import * as AccessGate from "./AccessGate.ts";
import {
  J5_LINK_PAIRING_SUBJECT,
  PairingIntents,
  recordConnectionsLinkCreator,
} from "./PairingIntents.ts";
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

  it.effect(
    "binds the startup link's, the desktop app's and T3 Connect's devices to the first owner",
    () =>
      Effect.gen(function* () {
        const intents = yield* PairingIntents;
        const people = yield* PersonAccess.PersonAccess;
        const sessions = yield* SessionStore.SessionStore;
        const owner = yield* people.firstOwner;
        for (const subject of ["administrative-bootstrap", "desktop-bootstrap", "cloud-connect"]) {
          const issued = yield* intents.issueSession({
            grant: { subject, scopes: LEVEL_PERMISSIONS.owner },
            credential: `credential-${subject}`,
            issue: sessions.issue({ subject, scopes: LEVEL_PERMISSIONS.owner }),
          });
          const devices = yield* people.listDevices(owner.personId);
          assert.isTrue(
            devices.some((device) => device.sessionId === issued.sessionId),
            subject,
          );
        }
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
        creatorLive: Effect.succeed(true),
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
        creatorLive: Effect.succeed(true),
      });
      assert.isNull(yield* intents.intentOf("credential-peer"));
    }),
  );

  it.effect("refuses a Connections link whose maker was removed while it was made", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const access = yield* Access;
      const maker = yield* person("Leaving", [{ scope: { kind: "server" }, level: "owner" }]);
      const laptop = yield* device(maker.personId, LEVEL_PERMISSIONS.owner);
      // Upstream has minted the link; the maker is removed before J5 records whose it is.
      yield* access.removePerson(maker.personId);
      const refused = yield* recordConnectionsLinkCreator({
        creator: laptop.identity,
        link: { id: "pairing:late", credential: "credential-late" },
        scopes: LEVEL_PERMISSIONS.owner,
      }).pipe(Effect.flip);
      // Upstream's handler revokes a link whose maker is not recorded.
      assert.strictEqual(refused.reason, "no_person");
      assert.isNull(yield* intents.intentOf("credential-late"));

      // A device no one has claimed still makes links, recorded as no one's.
      const unclaimed = yield* device(null, LEVEL_PERMISSIONS.owner);
      yield* recordConnectionsLinkCreator({
        creator: unclaimed.identity,
        link: { id: "pairing:unclaimed", credential: "credential-unclaimed" },
        scopes: LEVEL_PERMISSIONS.owner,
      });
      assert.isNull(yield* intents.intentOf("credential-unclaimed"));
    }),
  );

  it.effect("refuses a Connections link whose maker's device is ended while it is made", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const sessions = yield* SessionStore.SessionStore;
      const maker = yield* person("Ending", [{ scope: { kind: "server" }, level: "owner" }]);
      const laptop = yield* device(maker.personId, LEVEL_PERMISSIONS.owner);
      // Upstream's revoke waits here, once the gate has cut the laptop loose from its person.
      const revoking = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const auth = yield* EnvironmentAuth.EnvironmentAuth.pipe(
        Effect.provide(
          AccessGate.layerGatedEnvironmentAuth.pipe(
            Layer.provide(
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                revokeSession: (sessionId) =>
                  Deferred.succeed(revoking, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(sessions.revoke(sessionId)),
                    Effect.orDie,
                  ),
              }),
            ),
          ),
        ),
      );

      // Another device ends the laptop just as upstream has minted a link on it.
      const ending = yield* auth.revokeSession(laptop.sessionId).pipe(Effect.forkChild);
      yield* Deferred.await(revoking);
      // The record runs as far as it can while the revoke is paused: before the cut and the
      // revoke were one transaction, to its end, finding the laptop no one's and still live.
      const recording = yield* recordConnectionsLinkCreator({
        creator: laptop.identity,
        link: { id: "pairing:ending", credential: "credential-ending" },
        scopes: LEVEL_PERMISSIONS.owner,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(ending);

      // Refused, so upstream's handler revokes the link rather than leave it approving as no one.
      const recorded = yield* Fiber.join(recording).pipe(Effect.result);
      assert.isTrue(Result.isFailure(recorded), "the link was recorded as no one's");
      if (Result.isFailure(recorded)) assert.strictEqual(recorded.failure.reason, "no_person");
      assert.isNull(yield* intents.intentOf("credential-ending"));
    }),
  );
});
