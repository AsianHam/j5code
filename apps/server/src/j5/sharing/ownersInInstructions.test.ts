import { assert, it } from "@effect/vitest";
import { setServerOwners } from "@t3tools/provider-core/j5/orchestrationInstructions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";

import { Access } from "./Access.ts";
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
