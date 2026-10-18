import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthStandardClientScopes } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS, type PersonLevel } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
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

/** `--scope` as given; left out, the command's default. */
const pair = (
  given: Parameters<typeof flags>[0],
  scopes?: ReadonlyArray<(typeof AuthStandardClientScopes)[number]>,
  withoutPerson: "refuse" | "ask" = "refuse",
) =>
  Effect.gen(function* () {
    const grants = yield* PairingGrantStore.PairingGrantStore;
    return yield* pairingLinkForPerson({
      flags: flags(given),
      scopes: { scopes: scopes ?? AuthStandardClientScopes, given: scopes !== undefined },
      mint: (minted) => grants.issueOneTimeToken({ scopes: [...minted] }),
      withoutPerson,
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

  it.effect(
    "lets auth pairing create make upstream's link for a device the server will ask about",
    () =>
      Effect.gen(function* () {
        const intents = yield* PairingIntents;
        const people = yield* PersonAccess.PersonAccess;
        const sessions = yield* SessionStore.SessionStore;
        const made = yield* pair({}, undefined, "ask");
        assert.include(made.said, "asked who they are");
        assert.isNull(yield* intents.intentOf(made.link.credential));

        // It pairs a device the server cannot place, which says whose it is before anything else.
        const issued = yield* intents.issueSession({
          grant: { subject: "one-time-token", scopes: AuthStandardClientScopes },
          credential: made.link.credential,
          issue: sessions.issue({ scopes: AuthStandardClientScopes }),
        });
        const reach = yield* people.sessionReach({
          sessionId: issued.sessionId,
          subject: "one-time-token",
        });
        assert.strictEqual(reach.kind, "unknown");

        // A level or scope without a person is still refused: there is no one to give it to.
        assert.include(yield* refusal(pair({ level: "viewer" }, undefined, "ask")), "--person");
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

  it.effect(
    "keeps --scope as the ceiling only when it was given, and refuses one that gives nothing",
    () =>
      Effect.gen(function* () {
        const intents = yield* PairingIntents;
        yield* person("Ceiling person", [{ scope: { kind: "server" }, level: "viewer" }]);
        const followsLevel = yield* pair({ person: "Ceiling person" });
        assert.isNull((yield* intents.intentOf(followsLevel.link.credential))?.ceiling);
        // Every default named by hand is a ceiling all the same.
        const capped = yield* pair({ person: "Ceiling person" }, AuthStandardClientScopes);
        assert.deepStrictEqual(
          [...((yield* intents.intentOf(capped.link.credential))?.ceiling ?? [])],
          [...AuthStandardClientScopes],
        );
        assert.include(
          yield* refusal(pair({ person: "Ceiling person" }, ["terminal:operate"])),
          "--scope gives nothing within Ceiling person's level",
        );
      }),
  );

  it.effect("makes no link when whose it is cannot be recorded", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const gone = yield* person("Removed meanwhile", [
        { scope: { kind: "server" }, level: "viewer" },
      ]);
      const failed = yield* pairingLinkForPerson({
        flags: flags({ person: "Removed meanwhile" }),
        scopes: { scopes: AuthStandardClientScopes, given: false },
        withoutPerson: "refuse",
        // Upstream makes the link; the person goes before it is recorded as theirs.
        mint: (minted) =>
          grants
            .issueOneTimeToken({ scopes: [...minted], label: "Removed meanwhile" })
            .pipe(
              Effect.tap(
                () =>
                  sql`UPDATE j5_a2a_human_person SET removed_at = 'now' WHERE person_id = ${gone.personId}`,
              ),
            ),
      }).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "PairingIntentError");
      assert.isFalse(
        (yield* grants.listActive()).some((link) => link.label === "Removed meanwhile"),
      );
      assert.isNotNull(yield* people.readPerson(gone.personId));
    }),
  );

  it.effect("adds someone new only with a level, at the scope given", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const intents = yield* PairingIntents;
      // The live-test rig's `guest` tells this refusal by its tag.
      const unknown = yield* pair({ person: "Newcomer" }).pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "PairingPersonUnknownError");
      // The rig reads the tag from the CLI's log line, which prints the error's name.
      assert.strictEqual(unknown.name, "PairingPersonUnknownError");
      assert.include(unknown.message, "--level");
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
