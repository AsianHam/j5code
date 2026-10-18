import { assert, it } from "@effect/vitest";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { People } from "./People.ts";
import * as PersonAccess from "./PersonAccess.ts";
import {
  PROJECT,
  anySessionId,
  device,
  isLive,
  peopleLayer,
  person,
  thread,
} from "./test-support/accessHarness.ts";

const ownerDesktop = { sessionId: anySessionId("owner-desktop"), subject: "desktop-bootstrap" };

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { readonly _tag: string })._tag),
  );

it.layer(peopleLayer)("People", (it) => {
  it.effect("tells who reaches a thread, where each level is held, and ids only to an Owner", () =>
    Effect.gen(function* () {
      const people = yield* People;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          default_thread_env_mode, auto_pull, favicon_path, project_icon_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT}, 'Billing Migration', '/tmp/billing', NULL, 'local', 1, NULL, NULL, '[]',
          'now', 'now', NULL
        )
      `;
      const planning = yield* thread("thread:planning");
      const builder = yield* thread("thread:builder", PROJECT, {
        parent: "thread:planning",
        relationship: "subagent",
      });
      const viewer = yield* person("Contractor", [
        { scope: { kind: "thread", threadId: planning }, level: "viewer" },
      ]);
      yield* person("Teammate", [
        { scope: { kind: "project", projectId: PROJECT }, level: "collaborator" },
      ]);
      const outsider = yield* person("Outsider", [
        { scope: { kind: "thread", threadId: yield* thread("thread:elsewhere") }, level: "viewer" },
      ]);
      const contractorPhone = yield* device(viewer.personId, LEVEL_PERMISSIONS.viewer);
      const outsiderPhone = yield* device(outsider.personId, LEVEL_PERMISSIONS.viewer);

      const asOwner = yield* people.scopePeople(ownerDesktop, {
        kind: "thread",
        threadId: builder,
      });
      const byName = new Map(asOwner.people.map((entry) => [entry.name, entry]));
      assert.deepStrictEqual(byName.get("Contractor")?.via, [
        {
          via: "ancestor",
          level: "viewer",
          scope: { kind: "thread", threadId: planning },
          scopeTitle: "thread:planning",
        },
      ]);
      assert.deepStrictEqual(byName.get("Teammate")?.via, [
        {
          via: "project",
          level: "collaborator",
          scope: { kind: "project", projectId: PROJECT },
          scopeTitle: "Billing Migration",
        },
      ]);
      assert.isTrue(byName.get(null)?.firstOwner ?? false);
      assert.strictEqual(byName.get("Contractor")?.personId, viewer.personId);

      // Someone narrower is told names and levels, not ids.
      const asContractor = yield* people.scopePeople(contractorPhone.identity, {
        kind: "thread",
        threadId: builder,
      });
      assert.isTrue(asContractor.people.every((entry) => entry.personId === null));
      assert.isTrue(asContractor.people.find((entry) => entry.name === "Contractor")?.you ?? false);
      assert.strictEqual(
        yield* failure(
          people.scopePeople(outsiderPhone.identity, { kind: "thread", threadId: builder }),
        ),
        "ScopeNotSharedError",
      );
    }),
  );

  it.effect("never lowers or removes the first owner", () =>
    Effect.gen(function* () {
      const people = yield* People;
      const owner = yield* (yield* PersonAccess.PersonAccess).firstOwner;
      assert.strictEqual(
        yield* failure(
          people.setLevel({
            personId: owner.personId,
            scope: { kind: "server" },
            level: "collaborator",
          }),
        ),
        "FirstOwnerFixedError",
      );
      assert.strictEqual(
        yield* failure(people.removeLevel({ personId: owner.personId, scope: { kind: "server" } })),
        "FirstOwnerFixedError",
      );
      assert.strictEqual(yield* failure(people.remove(owner.personId)), "FirstOwnerFixedError");
    }),
  );

  it.effect("refuses a level at a thread the server does not hold", () =>
    Effect.gen(function* () {
      const people = yield* People;
      const sam = yield* person("Sam");
      assert.strictEqual(
        yield* failure(
          people.setLevel({
            personId: sam.personId,
            scope: { kind: "thread", threadId: "thread:missing" as never },
            level: "viewer",
          }),
        ),
        "ScopeNotFoundError",
      );
    }),
  );

  it.effect("lets a person rename themselves, and an Owner end one device of theirs", () =>
    Effect.gen(function* () {
      const people = yield* People;
      const records = yield* PersonAccess.PersonAccess;
      const prya = yield* person("Prya", [{ scope: { kind: "server" }, level: "viewer" }]);
      const laptop = yield* device(prya.personId, LEVEL_PERMISSIONS.viewer);
      const phone = yield* device(prya.personId, LEVEL_PERMISSIONS.viewer, {
        ceiling: LEVEL_PERMISSIONS.viewer,
      });

      yield* people.renameSelf(laptop.identity, "Priya");
      assert.strictEqual((yield* records.readPerson(prya.personId))?.displayName, "Priya");
      const listed = (yield* people.list(ownerDesktop)).find(
        (entry) => entry.personId === prya.personId,
      );
      const ceilingOf = (sessionId: string) =>
        listed?.devices.find((entry) => entry.sessionId === sessionId)?.ceiling;
      assert.isNull(ceilingOf(laptop.sessionId));
      assert.deepStrictEqual(ceilingOf(phone.sessionId), [...LEVEL_PERMISSIONS.viewer]);

      yield* people.revokeDevice(phone.sessionId);
      assert.isFalse(yield* isLive(phone.sessionId));
      assert.isTrue(yield* isLive(laptop.sessionId));
      assert.deepStrictEqual(
        (yield* records.listLevels(prya.personId)).map((held) => held.level),
        ["viewer"],
      );
      assert.strictEqual(
        yield* failure(people.revokeDevice(phone.sessionId)),
        "DeviceNotAPersonsError",
      );
    }),
  );
});
