import { assert, it } from "@effect/vitest";
import { setServerOwners } from "@t3tools/provider-core/j5/orchestrationInstructions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";

import { Access } from "./Access.ts";
import * as SqlClient from "effect/sql/SqlClient";

import { makeAgentPersonaRuntimePolicyResolver } from "../agents/agentPersonaRuntime.ts";
import { refreshOwnersInInstructions } from "./ownersInInstructions.ts";
import { PersonAccess } from "./PersonAccess.ts";
import { conversationLayer } from "./test-support/conversationHarness.ts";

it.effect("every agent's standing instructions name the server's Owners as they are (AC9)", () =>
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const access = yield* Access;
    const owner = yield* people.firstOwner;
    yield* access.rename({ personId: owner.personId, displayName: "Jackson" });
    yield* refreshOwnersInInstructions;
    // Read through upstream's constant, as each provider's adapter reads it.
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "This server belongs to Jackson.");

    const maria = yield* people.createPerson({ displayName: "Maria" });
    yield* access.setLevel({ personId: maria.personId, scope: { kind: "server" }, level: "owner" });
    // A Collaborator is not an Owner.
    const sam = yield* people.createPerson({ displayName: "Sam" });
    yield* access.setLevel({
      personId: sam.personId,
      scope: { kind: "server" },
      level: "collaborator",
    });
    yield* refreshOwnersInInstructions;
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "This server's owners are Jackson and Maria.",
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => setServerOwners([]))),
    Effect.provide(conversationLayer),
  ),
);

it.effect("an Owner named from another process, such as the CLI, is named at the next turn", () =>
  Effect.gen(function* () {
    const people = yield* PersonAccess;
    const sql = yield* SqlClient.SqlClient;
    const owner = yield* people.firstOwner;
    yield* people.setName({ personId: owner.personId, displayName: "Jackson" });
    // Written straight to the database, as the CLI's own process writes it: no change is told
    // to this server's subscribers.
    const maria = yield* people.createPerson({ displayName: "Maria" });
    yield* sql`
      INSERT INTO j5_a2a_person_level
        (person_id, scope_kind, scope_id, level, created_at, updated_at)
      VALUES (${maria.personId}, 'server', '', 'owner', '2026-10-18T00:00:00.000Z',
        '2026-10-18T00:00:00.000Z')
    `;
    // A turn's runtime policy is resolved just before the provider reads the instructions.
    const resolve = yield* makeAgentPersonaRuntimePolicyResolver(
      (_input, cause) => new Error(String(cause)),
    );
    yield* resolve({
      thread: {
        id: "thread:turn",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      } as never,
      cwd: null,
    });
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "This server's owners are Jackson and Maria.",
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => setServerOwners([]))),
    Effect.provide(conversationLayer),
  ),
);
