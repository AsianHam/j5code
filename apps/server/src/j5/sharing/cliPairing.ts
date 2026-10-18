import { type AuthEnvironmentScope, AuthGrantScope, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type PersonLevel,
  type PersonScope,
  devicePermissions,
  highestLevel,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Flag } from "effect/cli";

import type { ParticipantId } from "../a2a/contracts.ts";
import { Access } from "./Access.ts";
import { requireScope } from "./Links.ts";
import { PairingIntents } from "./PairingIntents.ts";
import { checkedPersonName } from "./personNames.ts";
import {
  type HeldLevel,
  OwnerOutsideServerError,
  PersonAccess,
  personNameKey,
} from "./PersonAccess.ts";

/**
 * `j5 pair` and `j5 auth pairing create` name the person a device is for (register D36, People
 * and access AC4). Upstream's commands carry these flags and make their link through
 * `pairingLinkForPerson` (FORK.md case 79). A name that matches someone makes the link for them
 * at their levels; one that matches no one creates that person at the level and scope given.
 * Upstream's `--scope` keeps its meaning: it narrows the device's permissions within the level,
 * and becomes the device's ceiling.
 *
 * `j5 pair` refuses without `--person`. `j5 auth pairing create` without it makes upstream's own
 * link, for a device the server will ask about: upstream's desktop app runs that bare command on
 * a host it reaches over SSH, and knows no one's name there. Such a device reaches nothing until
 * it says whose it is (AC5), so it never silently belongs to someone the server assumed.
 */

export const personPairingFlags = {
  person: Flag.String("person").pipe(
    Flag.withDescription(
      "Who the device is for. A name already on the server pairs a device for that person; a new name adds them, with --level.",
    ),
    Flag.optional,
  ),
  level: Flag.Literals("level", ["viewer", "collaborator", "owner"]).pipe(
    Flag.withDescription("The level a new person is added at. Needed only for a new person."),
    Flag.optional,
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription("Add a new person at this project's scope rather than the server's."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Add a new person at this thread's scope rather than the server's."),
    Flag.optional,
  ),
};

/** The permissions `--scope` asked for, or the command's default, and whether it was given. */
export interface PairingScopes {
  readonly scopes: ReadonlyArray<AuthGrantScope>;
  readonly given: boolean;
}

/**
 * Upstream's `--scope` flag (`cli/authScopes.ts`), which also says whether it was given at all:
 * given, it is the device's ceiling; left out, the device follows its person's level, whatever
 * upstream's default is.
 */
export const pairingScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  Flag.Literals("scope", AuthGrantScope.literals).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes): PairingScopes => ({
      scopes: [...new Set(scopes.length > 0 ? scopes : defaults)],
      given: scopes.length > 0,
    })),
  );

export interface PersonPairingFlags {
  readonly person: Option.Option<string>;
  readonly level: Option.Option<PersonLevel>;
  readonly project: Option.Option<string>;
  readonly thread: Option.Option<string>;
}

export class PairingPersonError extends Schema.TaggedError<PairingPersonError>()(
  "PairingPersonError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * A name that matches no one, given without the level a new person needs. Its own tag, so the
 * live-test rig's `guest` can tell it apart from every other refusal and add the person instead.
 */
export class PairingPersonUnknownError extends Schema.TaggedError<PairingPersonUnknownError>()(
  "PairingPersonUnknownError",
  { personName: Schema.String },
) {
  override get message(): string {
    return `No one on this server is called ${this.personName}. To add them, give --level (viewer, collaborator or owner), with --project or --thread for a scope narrower than the server.`;
  }
}

const LEVEL_NAMES: Record<PersonLevel, string> = {
  viewer: "Viewer",
  collaborator: "Collaborator",
  owner: "Owner",
};

/** Makes a pairing link for the person `--person` names, and says what it did. */
export const pairingLinkForPerson = Effect.fn("j5.sharing.cliPairing.pairingLinkForPerson")(
  function* <L extends { readonly id: string; readonly credential: string }, E, R>(input: {
    readonly flags: PersonPairingFlags;
    readonly scopes: PairingScopes;
    readonly mint: (scopes: ReadonlyArray<AuthEnvironmentScope>) => Effect.Effect<L, E, R>;
    /** What a link without `--person` is: refused, or one for a device the server will ask about. */
    readonly withoutPerson: "refuse" | "ask";
  }) {
    const sql = yield* SqlClient.SqlClient;
    const people = yield* PersonAccess;
    const access = yield* Access;
    const intents = yield* PairingIntents;
    const refuse = (reason: string) => Effect.fail(new PairingPersonError({ reason }));

    const titleOf = (scope: PersonScope) =>
      scope.kind === "server"
        ? Effect.succeed("the server")
        : (scope.kind === "project"
            ? sql<{ readonly title: string }>`
                SELECT title FROM projection_projects WHERE project_id = ${scope.projectId}
              `
            : sql<{ readonly title: string }>`
                SELECT title FROM orchestration_v2_projection_threads
                WHERE thread_id = ${scope.threadId}
              `
          ).pipe(Effect.map((rows) => `${scope.kind} "${rows[0]?.title ?? "?"}"`));
    const describeLevels = (levels: ReadonlyArray<HeldLevel>) =>
      levels.length === 0
        ? Effect.succeed("no level")
        : Effect.forEach(levels, (held) =>
            titleOf(held.scope).pipe(
              Effect.map((title) => `${LEVEL_NAMES[held.level]} on ${title}`),
            ),
          ).pipe(Effect.map((parts) => parts.join(", ")));

    const everyone = yield* people.listPeople;
    const { flags } = input;
    if (
      Option.isNone(flags.person) &&
      input.withoutPerson === "ask" &&
      Option.isNone(flags.level) &&
      Option.isNone(flags.project) &&
      Option.isNone(flags.thread)
    ) {
      // Upstream's link as upstream makes it, with no record of a person.
      return {
        link: yield* input.mint(input.scopes.scopes),
        said: "Made a link for a device the server does not know yet: whoever pairs it is asked who they are before they can use anything.",
      };
    }
    if (Option.isNone(flags.person)) {
      const named = yield* Effect.forEach(
        everyone.filter((record) => record.person.displayName !== null),
        (record) =>
          describeLevels(record.levels).pipe(
            Effect.map((levels) => `  ${record.person.displayName} (${levels})`),
          ),
      );
      return yield* refuse(
        [
          "Name the person this device is for with --person.",
          ...(named.length === 0 ? [] : ["People on this server:", ...named]),
          "A name that matches no one adds that person; give --level with it.",
        ].join("\n"),
      );
    }
    const name = yield* checkedPersonName(flags.person.value);
    const ceiling = input.scopes.given ? input.scopes.scopes : null;
    // The link and the record of whose it is commit together: a link made without it would pair
    // a device the server could not place. Upstream's link is written through the same database
    // client (`cliEnvironmentAuth` builds both over one runtime).
    const mintFor = (personId: ParticipantId, levels: ReadonlyArray<HeldLevel>) =>
      Effect.gen(function* () {
        const granted = devicePermissions(highestLevel(levels.map((held) => held.level)), ceiling);
        if (granted.length === 0) {
          return yield* refuse(`--scope gives nothing within ${name}'s level.`);
        }
        const link = yield* input.mint(granted);
        yield* intents.record({
          pairingLinkId: link.id,
          credential: link.credential,
          personId,
          linkId: null,
          ceiling,
        });
        return link;
      });
    const existing = everyone.find(
      (record) =>
        record.person.displayName !== null &&
        personNameKey(record.person.displayName) === personNameKey(name),
    );

    if (existing !== undefined) {
      if (
        Option.isSome(flags.level) ||
        Option.isSome(flags.project) ||
        Option.isSome(flags.thread)
      ) {
        return yield* refuse(
          `${existing.person.displayName} is already on this server. Change what they reach from the People page, or leave out --level, --project and --thread to pair a device for them.`,
        );
      }
      const link = yield* sql.withTransaction(mintFor(existing.person.personId, existing.levels));
      const levels = yield* describeLevels(existing.levels);
      return { link, said: `Made a link for ${existing.person.displayName} (${levels}).` };
    }

    if (Option.isNone(flags.level)) {
      return yield* new PairingPersonUnknownError({ personName: name });
    }
    if (Option.isSome(flags.project) && Option.isSome(flags.thread)) {
      return yield* refuse("Give --project or --thread, not both.");
    }
    const scope: PersonScope = Option.isSome(flags.project)
      ? { kind: "project", projectId: ProjectId.make(flags.project.value) }
      : Option.isSome(flags.thread)
        ? { kind: "thread", threadId: ThreadId.make(flags.thread.value) }
        : { kind: "server" };
    const level = flags.level.value;
    if (level === "owner" && scope.kind !== "server") return yield* new OwnerOutsideServerError({});
    yield* requireScope(sql, scope);
    // The person, their level and their link commit together, so a failure leaves no one behind.
    const made = yield* sql.withTransaction(
      Effect.gen(function* () {
        const person = yield* people.createPerson({ displayName: name });
        yield* access.setLevel({ personId: person.personId, scope, level });
        return yield* mintFor(person.personId, [{ scope, level }]);
      }),
    );
    const levels = yield* describeLevels([{ scope, level }]);
    return { link: made, said: `Added ${name} (${levels}), and made a link for them.` };
  },
);
