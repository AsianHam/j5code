import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthStandardClientScopes } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS, type PersonLevel } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import { pairingLinkForPerson } from "./cliPairing.ts";
import { PairingIntents } from "./PairingIntents.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { accessLayer, person, thread } from "./test-support/accessHarness.ts";

/** What `--person`, `--level`, `--project` and `--thread` were given as. */
const flags = (
  input: {
    readonly person?: string;
    readonly level?: PersonLevel;
    readonly project?: string;
    readonly thread?: string;
  } = {},
) => ({
  person: Option.fromUndefinedOr(input.person),
  level: Option.fromUndefinedOr(input.level),
  project: Option.fromUndefinedOr(input.project),
  thread: Option.fromUndefinedOr(input.thread),
});

const pair = (
  given: Parameters<typeof flags>[0],
  scopes: ReadonlyArray<(typeof AuthStandardClientScopes)[number]> = AuthStandardClientScopes,
) =>
  Effect.gen(function* () {
    const grants = yield* PairingGrantStore.PairingGrantStore;
    return yield* pairingLinkForPerson({
      flags: flags(given),
      scopes,
      mint: (minted) => grants.issueOneTimeToken({ scopes: [...minted] }),
    });
  });

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { readonly message: string }).message),
  );

it.layer(accessLayer)("j5 pair --person", (it) => {
  it.effect("refuses without a person, and lists the people it could be for", () =>
    Effect.gen(function* () {
      yield* person("Priya", [{ scope: { kind: "server" }, level: "collaborator" }]);
      const message = yield* refusal(pair({}));
      assert.include(message, "--person");
      assert.include(message, "Priya (Collaborator on the server)");
    }),
  );

  it.effect("makes the link for someone already here, at their level, and says so", () =>
    Effect.gen(function* () {
      const intents = yield* PairingIntents;
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const sam = yield* person("Sam", [{ scope: { kind: "server" }, level: "viewer" }]);
      const made = yield* pair({ person: " sam " });
      assert.strictEqual(made.said, "Made a link for Sam (Viewer on the server).");
      assert.strictEqual((yield* intents.intentOf(made.link.credential))?.personId, sam.personId);
      const minted = (yield* grants.listActive()).find((link) => link.id === made.link.id);
      assert.deepStrictEqual([...(minted?.scopes ?? [])], [...LEVEL_PERMISSIONS.viewer]);

      // Giving them more is done in place, not by a link.
      assert.include(
        yield* refusal(pair({ person: "Sam", level: "collaborator" })),
        "already on this server",
      );
    }),
  );

  it.effect("adds someone new only with a level, at the scope given", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const intents = yield* PairingIntents;
      assert.include(yield* refusal(pair({ person: "Newcomer" })), "--level");
      const review = yield* thread("thread:review");
      assert.strictEqual(
        (yield* pair({ person: "Owner here", level: "owner", thread: review }).pipe(Effect.flip))
          ._tag,
        "OwnerOutsideServerError",
      );

      // `--scope` narrows the device within the level, and stays its ceiling.
      const made = yield* pair({ person: "Newcomer", level: "collaborator", thread: review }, [
        AuthOrchestrationReadScope,
      ]);
      assert.strictEqual(
        made.said,
        'Added Newcomer (Collaborator on thread "thread:review"), and made a link for them.',
      );
      const intent = yield* intents.intentOf(made.link.credential);
      assert.deepStrictEqual(intent?.ceiling, [AuthOrchestrationReadScope]);
      assert.deepStrictEqual(yield* people.listLevels(intent!.personId), [
        { scope: { kind: "thread", threadId: review }, level: "collaborator" },
      ]);
    }),
  );
});
