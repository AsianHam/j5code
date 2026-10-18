import { assert, it } from "@effect/vitest";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import { Links } from "./Links.ts";
import { PairingIntents } from "./PairingIntents.ts";
import { People } from "./People.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { anySessionId, device, peopleLayer, person, thread } from "./test-support/accessHarness.ts";

/** The first owner's desktop app, which is theirs by how it was issued. */
const ownerDesktop = { sessionId: anySessionId("owner-desktop"), subject: "desktop-bootstrap" };

const namedOwner = Effect.gen(function* () {
  const people = yield* PersonAccess.PersonAccess;
  const owner = yield* people.firstOwner;
  if (owner.displayName === null) {
    yield* people.setName({ personId: owner.personId, displayName: "Jackson" });
  }
  return owner;
});

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { readonly _tag: string })._tag),
  );

const personNamed = (name: string) =>
  PersonAccess.PersonAccess.use((people) => people.listPeople).pipe(
    Effect.map((records) => records.find((record) => record.person.displayName === name) ?? null),
  );

it.layer(peopleLayer)("Links", (it) => {
  it.effect("keeps a link to copy again, and lists a device link under its person", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      const people = yield* People;
      yield* namedOwner;
      const room = yield* thread("thread:room");
      const invite = yield* links.create(ownerDesktop, {
        kind: "invite",
        scope: { kind: "thread", threadId: room },
        level: "viewer",
        use: "many",
        name: null,
      });
      const priya = yield* person("Priya", [{ scope: { kind: "server" }, level: "collaborator" }]);
      const phone = yield* links.create(ownerDesktop, { kind: "device", personId: priya.personId });

      const listed = yield* links.list;
      assert.strictEqual(listed.find((link) => link.linkId === invite.linkId)?.token, invite.token);
      assert.strictEqual(listed.find((link) => link.linkId === phone.linkId)?.personName, "Priya");
      const entry = (yield* people.list(ownerDesktop)).find(
        (candidate) => candidate.personId === priya.personId,
      );
      assert.deepStrictEqual(
        entry?.unusedLinks.map((link) => link.linkId),
        [phone.linkId],
      );
      // Seven days unless the Owner says otherwise.
      assert.strictEqual(
        invite.expiresAt.epochMilliseconds - invite.createdAt.epochMilliseconds,
        Duration.toMillis(Duration.days(7)),
      );
    }),
  );

  it.effect("gives a link for many Viewer only, and makes no link for someone already here", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      yield* namedOwner;
      yield* person("Morgan");
      const lecture = yield* thread("thread:lecture");
      const scope = { kind: "thread" as const, threadId: lecture };
      assert.strictEqual(
        yield* failure(
          links.create(ownerDesktop, {
            kind: "invite",
            scope,
            level: "collaborator",
            use: "many",
            name: null,
          }),
        ),
        "LinkForManyIsViewerError",
      );
      assert.strictEqual(
        yield* failure(
          links.create(ownerDesktop, {
            kind: "invite",
            scope,
            level: "viewer",
            use: "one",
            name: " morgan ",
          }),
        ),
        "PersonAlreadyHereError",
      );
      assert.strictEqual(
        yield* failure(
          links.create(ownerDesktop, {
            kind: "invite",
            scope,
            level: "owner",
            use: "one",
            name: null,
          }),
        ),
        "OwnerOutsideServerError",
      );
    }),
  );

  it.effect(
    "brings in one person at the link's level with a credential for their device, once",
    () =>
      Effect.gen(function* () {
        const links = yield* Links;
        const intents = yield* PairingIntents;
        const grants = yield* PairingGrantStore.PairingGrantStore;
        yield* namedOwner;
        const billing = yield* thread("thread:billing");
        const link = yield* links.create(ownerDesktop, {
          kind: "invite",
          scope: { kind: "thread", threadId: billing },
          level: "collaborator",
          use: "one",
          name: "Contractor",
        });

        // The name offered is only offered; the person corrects it as they join.
        const joined = yield* links.join({ token: link.token, name: "Dana", session: null });
        assert.strictEqual(joined.kind, "pair");
        if (joined.kind !== "pair") return;
        const dana = yield* personNamed("Dana");
        assert.deepStrictEqual(dana?.levels, [
          { scope: { kind: "thread", threadId: billing }, level: "collaborator" },
        ]);
        const intent = yield* intents.intentOf(joined.credential);
        assert.strictEqual(intent?.personId, dana?.person.personId);
        assert.strictEqual(intent?.linkId, link.linkId);
        // Upstream's credential holds exactly what the level gives.
        const pending = (yield* grants.listActive()).find(
          (entry) => entry.id === intent?.pairingLinkId,
        );
        assert.deepStrictEqual([...(pending?.scopes ?? [])], [...LEVEL_PERMISSIONS.collaborator]);

        assert.strictEqual(
          yield* failure(links.join({ token: link.token, name: "Dana again", session: null })),
          "LinkRefusedError",
        );
        assert.isUndefined((yield* links.list).find((entry) => entry.linkId === link.linkId));
      }),
  );

  it.effect("lets only one of two browsers racing for a link for one person have it", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      yield* namedOwner;
      const link = yield* links.create(ownerDesktop, {
        kind: "invite",
        scope: { kind: "server" },
        level: "viewer",
        use: "one",
        name: null,
      });
      const results = yield* Effect.all(
        [
          Effect.result(links.join({ token: link.token, name: "Racer one", session: null })),
          Effect.result(links.join({ token: link.token, name: "Racer two", session: null })),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
      const joinedPeople = [yield* personNamed("Racer one"), yield* personNamed("Racer two")];
      assert.strictEqual(joinedPeople.filter((entry) => entry !== null).length, 1);
    }),
  );

  it.effect(
    "refuses a device paired as someone else, or as the link's own person, and keeps the link",
    () =>
      Effect.gen(function* () {
        const links = yield* Links;
        yield* namedOwner;
        const riley = yield* person("Riley", [{ scope: { kind: "server" }, level: "viewer" }]);
        const quinn = yield* person("Quinn", [{ scope: { kind: "server" }, level: "viewer" }]);
        const rileyLaptop = yield* device(riley.personId, LEVEL_PERMISSIONS.viewer);
        const quinnLaptop = yield* device(quinn.personId, LEVEL_PERMISSIONS.viewer);
        const forRiley = yield* links.create(ownerDesktop, {
          kind: "device",
          personId: riley.personId,
        });
        const invite = yield* links.create(ownerDesktop, {
          kind: "invite",
          scope: { kind: "server" },
          level: "viewer",
          use: "one",
          name: null,
        });

        // AC32: paired as someone else.
        assert.strictEqual(
          yield* failure(
            links.join({ token: forRiley.token, name: undefined, session: quinnLaptop.identity }),
          ),
          "LinkForSomeoneElseError",
        );
        assert.strictEqual(
          yield* failure(
            links.join({ token: invite.token, name: "Someone", session: quinnLaptop.identity }),
          ),
          "LinkForSomeoneElseError",
        );
        // AC43: paired as the person the link is for.
        assert.strictEqual(
          yield* failure(
            links.join({ token: forRiley.token, name: undefined, session: rileyLaptop.identity }),
          ),
          "LinkAlreadyYoursError",
        );
        const described = yield* links.describe(forRiley.token, rileyLaptop.identity);
        assert.deepStrictEqual(described.description.device, {
          state: "paired",
          name: "Riley",
          samePerson: true,
        });

        // Each link still pairs the device it was made for.
        const phone = yield* links.join({ token: forRiley.token, name: undefined, session: null });
        assert.strictEqual(phone.kind, "pair");
        const joined = yield* links.join({ token: invite.token, name: "Avery", session: null });
        assert.strictEqual(joined.kind, "pair");
      }),
  );

  it.effect("renames the person a device link is for when they correct their name", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      yield* namedOwner;
      const prya = yield* person("Prya", [{ scope: { kind: "server" }, level: "viewer" }]);
      yield* person("Taken name");
      const link = yield* links.create(ownerDesktop, { kind: "device", personId: prya.personId });

      // A name someone else has is refused, and the link is not spent (AC42, AC44).
      assert.strictEqual(
        yield* failure(links.join({ token: link.token, name: "taken  NAME", session: null })),
        "PersonNameTakenError",
      );
      yield* links.join({ token: link.token, name: "Priya Shah", session: null });
      const people = yield* PersonAccess.PersonAccess;
      assert.strictEqual((yield* people.readPerson(prya.personId))?.displayName, "Priya Shah");
    }),
  );

  it.effect("lets someone already paired join a link for many as themselves, keeping more", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      yield* namedOwner;
      const demo = yield* thread("thread:demo");
      const scope = { kind: "thread" as const, threadId: demo };
      const lead = yield* person("Lead", [{ scope: { kind: "server" }, level: "collaborator" }]);
      const visitor = yield* person("Visitor", [
        { scope: { kind: "thread", threadId: yield* thread("thread:other") }, level: "viewer" },
      ]);
      const leadLaptop = yield* device(lead.personId, LEVEL_PERMISSIONS.collaborator);
      const visitorLaptop = yield* device(visitor.personId, LEVEL_PERMISSIONS.viewer);
      const link = yield* links.create(ownerDesktop, {
        kind: "invite",
        scope,
        level: "viewer",
        use: "many",
        name: null,
      });

      assert.deepStrictEqual(
        yield* links.join({ token: link.token, name: undefined, session: leadLaptop.identity }),
        { kind: "joined" },
      );
      assert.deepStrictEqual(
        yield* links.join({ token: link.token, name: undefined, session: visitorLaptop.identity }),
        { kind: "joined" },
      );
      const people = yield* PersonAccess.PersonAccess;
      // The Collaborator already reaches the thread, and is given nothing lower beside it.
      assert.deepStrictEqual(yield* people.listLevels(lead.personId), [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      assert.strictEqual(yield* people.threadLevel(visitor.personId, demo), "viewer");

      // Someone new types a name and becomes a person of their own.
      yield* links.join({ token: link.token, name: "Guest in the room", session: null });
      assert.isNotNull(yield* personNamed("Guest in the room"));
      assert.strictEqual(
        (yield* links.list).find((entry) => entry.linkId === link.linkId)?.joined,
        3,
      );
    }),
  );

  it.effect("answers every link that does not work alike, and revoking removes no one", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      const sql = yield* SqlClient.SqlClient;
      yield* namedOwner;
      const gone = yield* thread("thread:gone");
      const open = (threadId = gone) =>
        links.create(ownerDesktop, {
          kind: "invite",
          scope: { kind: "thread", threadId },
          level: "viewer",
          use: "many",
          name: null,
        });
      const revoked = yield* open(yield* thread("thread:kept"));
      yield* links.join({ token: revoked.token, name: "Joined before", session: null });
      yield* links.revoke(revoked.linkId);
      const deleted = yield* open();
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'now' WHERE thread_id = ${gone}`;
      const expiring = yield* links.create(ownerDesktop, {
        kind: "invite",
        scope: { kind: "server" },
        level: "viewer",
        use: "many",
        name: null,
        lifetime: "1h",
      });
      yield* TestClock.adjust(Duration.hours(2));

      for (const token of [revoked.token, deleted.token, expiring.token, "no-such-link"]) {
        assert.strictEqual(yield* failure(links.describe(token, null)), "LinkRefusedError");
        assert.strictEqual(
          yield* failure(links.join({ token, name: "Late", session: null })),
          "LinkRefusedError",
        );
      }
      const before = yield* personNamed("Joined before");
      assert.isNotNull(before);
      assert.strictEqual(
        (yield* (yield* PersonAccess.PersonAccess).listLevels(before!.person.personId)).length,
        1,
      );
    }),
  );

  it.effect("revokes a person's unused links when they are removed", () =>
    Effect.gen(function* () {
      const links = yield* Links;
      const people = yield* People;
      yield* namedOwner;
      const leaving = yield* person("Leaving", [{ scope: { kind: "server" }, level: "viewer" }]);
      const link = yield* links.create(ownerDesktop, {
        kind: "device",
        personId: leaving.personId,
      });
      yield* people.remove(leaving.personId);
      assert.strictEqual(
        yield* failure(links.join({ token: link.token, name: undefined, session: null })),
        "LinkRefusedError",
      );
    }),
  );
});
