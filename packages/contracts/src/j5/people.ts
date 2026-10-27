import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  AuthClientMetadata,
  AuthEnvironmentScope,
  AuthGrantScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { AuthSessionId, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProjectIconOverride } from "../project.ts";
import { HeldPersonLevel } from "./access.ts";
import { J5ActionError } from "./actionError.ts";
import { PersonLevel, PersonScope } from "./levels.ts";
import { SharingLinkLifetime, SharingPersonName } from "./sharing.ts";

/**
 * People, their levels, devices and links (docs/j5/product/features/people-and-access.md). Every
 * change needs upstream's Manage access, which only an Owner's devices hold; renaming oneself and
 * reading who reaches a scope need only what every device holds.
 */
export const J5_PEOPLE_WS_METHODS = {
  /** Everyone on the server with their levels, devices and unused links. An Owner's request. */
  listPeople: "j5.people.list",
  /** Who reaches one thread or project, by name and level (AC26). */
  listScopePeople: "j5.people.listScope",
  /** Moves each time `listScopePeople` would answer differently for that scope. */
  subscribeScopePeopleChanges: "j5.people.subscribeScopeChanges",
  setLevel: "j5.people.setLevel",
  removeLevel: "j5.people.removeLevel",
  removePerson: "j5.people.remove",
  renamePerson: "j5.people.rename",
  /** A person renames themselves (AC46). */
  renameSelf: "j5.people.renameSelf",
  revokeDevice: "j5.people.revokeDevice",
  createLink: "j5.people.createLink",
  listLinks: "j5.people.listLinks",
  revokeLink: "j5.people.revokeLink",
} as const;

/** One device paired as a person, with the permissions it holds and the ceiling it was paired with. */
export const PersonDevice = Schema.Struct({
  sessionId: AuthSessionId,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  permissions: Schema.Array(Schema.String),
  /** The permissions it was paired with in Connections or by `--scope`; `null` for none. */
  ceiling: Schema.NullOr(Schema.Array(Schema.String)),
});
export type PersonDevice = typeof PersonDevice.Type;

/**
 * A link in force (AC41). Its token is kept so that an Owner can copy the link again until it
 * expires, is revoked or, for a link for one person, is used. A `device` link adds a further
 * device of someone already on the server and carries no level; an `invite` brings someone in at
 * its scope and level.
 */
export const PeopleLink = Schema.Struct({
  linkId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  kind: Schema.Literals(["device", "invite"]),
  scope: Schema.NullOr(PersonScope),
  level: Schema.NullOr(PersonLevel),
  /** One person, or many: a link for many is a Viewer's (AC40). */
  use: Schema.Literals(["one", "many"]),
  /** The person a device link is for; `null` for an invite, whose person is made as it is used. */
  personId: Schema.NullOr(TrimmedNonEmptyString),
  personName: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  /** How many people have joined with it. */
  joined: Schema.Number,
});
export type PeopleLink = typeof PeopleLink.Type;

export const PeopleEntry = Schema.Struct({
  personId: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  firstOwner: Schema.Boolean,
  /** The person asking. */
  you: Schema.Boolean,
  levels: Schema.Array(HeldPersonLevel),
  devices: Schema.Array(PersonDevice),
  /** Links for this person that are still unused. */
  unusedLinks: Schema.Array(PeopleLink),
});
export type PeopleEntry = typeof PeopleEntry.Type;

export const PeopleList = Schema.Struct({ people: Schema.Array(PeopleEntry) });
export type PeopleList = typeof PeopleList.Type;

/** How someone reaches a thread or project: there, through a thread above it, its project, or the server. */
export const ScopeReachVia = Schema.Literals(["thread", "ancestor", "project", "server"]);
export type ScopeReachVia = typeof ScopeReachVia.Type;

/**
 * One level by which someone reaches a thread or project: where it is held, by the name a person
 * knows that place by, so the Share dialog can say "Viewer · via Live test repo" and change it
 * there (AC36).
 */
export const ScopeReach = Schema.Struct({
  via: ScopeReachVia,
  level: PersonLevel,
  scope: PersonScope,
  /** The project's or thread's title; `null` for the server. */
  scopeTitle: Schema.NullOr(Schema.String),
});
export type ScopeReach = typeof ScopeReach.Type;

export const ScopePerson = Schema.Struct({
  /** Told to an Owner, who acts on the person by it; `null` for anyone else. */
  personId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  /** The highest level they hold over the scope. */
  level: PersonLevel,
  /** Where each of those levels is held, told to an Owner; empty for anyone else. */
  via: Schema.Array(ScopeReach),
  firstOwner: Schema.Boolean,
  you: Schema.Boolean,
});
export type ScopePerson = typeof ScopePerson.Type;

export const ProjectOrThreadScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type ProjectOrThreadScope = typeof ProjectOrThreadScope.Type;

export const ScopePeopleRequest = Schema.Struct({ scope: ProjectOrThreadScope });
export type ScopePeopleRequest = typeof ScopePeopleRequest.Type;

export const ScopePeople = Schema.Struct({ people: Schema.Array(ScopePerson) });
export type ScopePeople = typeof ScopePeople.Type;

export const ScopePeopleChange = Schema.Struct({ revision: Schema.Number });
export type ScopePeopleChange = typeof ScopePeopleChange.Type;

export const SetLevelRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  scope: PersonScope,
  level: PersonLevel,
});
export type SetLevelRequest = typeof SetLevelRequest.Type;

export const RemoveLevelRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  scope: PersonScope,
});
export type RemoveLevelRequest = typeof RemoveLevelRequest.Type;

export const PersonIdRequest = Schema.Struct({ personId: TrimmedNonEmptyString });
export type PersonIdRequest = typeof PersonIdRequest.Type;

export const RenamePersonRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  name: SharingPersonName,
});
export type RenamePersonRequest = typeof RenamePersonRequest.Type;

export const RenameSelfRequest = Schema.Struct({ name: SharingPersonName });
export type RenameSelfRequest = typeof RenameSelfRequest.Type;

export const DeviceRequest = Schema.Struct({ sessionId: AuthSessionId });
export type DeviceRequest = typeof DeviceRequest.Type;

/**
 * A link to make. A `device` link pairs one more device for someone already on the server. An
 * `invite` brings someone in: for one person, named or not, at any level the scope allows; for
 * many, at Viewer only.
 */
export const CreateLinkRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("device"),
    personId: TrimmedNonEmptyString,
    lifetime: Schema.optionalKey(SharingLinkLifetime),
  }),
  Schema.Struct({
    kind: Schema.Literal("invite"),
    scope: PersonScope,
    level: PersonLevel,
    use: Schema.Literals(["one", "many"]),
    /** The name to offer whoever opens a link for one person; they may change it. */
    name: Schema.NullOr(SharingPersonName),
    lifetime: Schema.optionalKey(SharingLinkLifetime),
  }),
]);
export type CreateLinkRequest = typeof CreateLinkRequest.Type;

export const LinkIdRequest = Schema.Struct({ linkId: TrimmedNonEmptyString });
export type LinkIdRequest = typeof LinkIdRequest.Type;

export const PeopleLinks = Schema.Struct({ links: Schema.Array(PeopleLink) });
export type PeopleLinks = typeof PeopleLinks.Type;

/** Where a client asks what a link opens. It takes no sign-in and spends nothing. */
export const J5_LINK_DESCRIBE_PATH = "/api/j5/links/describe";
/** Where someone who opens a link joins. It takes no sign-in: the link's token is what it trusts. */
export const J5_LINK_JOIN_PATH = "/api/j5/links/join";

/** A link's token, sent in the body and never in a URL a server logs. */
export const LinkTokenRequest = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type LinkTokenRequest = typeof LinkTokenRequest.Type;

/** One thing a link opens, by the names a person would know it by. */
export const LinkOpens = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("server") }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectTitle: Schema.String,
    projectIcon: Schema.NullOr(ProjectIconOverride),
    /** J5's own signed favicon link, relative to the server, when there is no chosen icon. */
    projectFaviconUrl: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadTitle: Schema.String,
    projectTitle: Schema.NullOr(Schema.String),
    projectIcon: Schema.NullOr(ProjectIconOverride),
    projectFaviconUrl: Schema.NullOr(Schema.String),
  }),
]);
export type LinkOpens = typeof LinkOpens.Type;

/**
 * What a link that works opens (AC42), and what this browser is on the server already. Every link
 * that does not work is answered alike, with status 404 and `error: "link_refused"`.
 */
export const LinkDescription = Schema.Struct({
  serverName: Schema.String,
  kind: Schema.Literals(["device", "invite"]),
  use: Schema.Literals(["one", "many"]),
  opens: LinkOpens,
  /** `null` for a device link, which adds a device and no level. */
  level: Schema.NullOr(PersonLevel),
  /** The name to offer: the person a link for one names. */
  personName: Schema.NullOr(Schema.String),
  /**
   * What this browser already is here. `paired` with `samePerson: false` is refused for a link
   * for one person (AC32), and with `samePerson: true` too (AC43); for a link for many, the
   * browser joins as itself (AC33).
   */
  device: Schema.Union([
    Schema.Struct({ state: Schema.Literal("unpaired") }),
    Schema.Struct({
      state: Schema.Literal("paired"),
      name: Schema.NullOr(Schema.String),
      samePerson: Schema.Boolean,
    }),
  ]),
  expiresAt: Schema.DateTimeUtc,
});
export type LinkDescription = typeof LinkDescription.Type;

/** What someone sends to join; a browser already paired for a link for many sends no name. */
export const JoinLinkRequest = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  name: Schema.optionalKey(SharingPersonName),
});
export type JoinLinkRequest = typeof JoinLinkRequest.Type;

/**
 * What joining did: a credential the browser pairs with at once on upstream's pairing route, or,
 * for a browser already paired that joined a link for many, nothing more to do. Refusals carry a
 * status and `error`: 404 `link_refused`, 409 `name_taken`, 409 `paired_as_someone_else`,
 * 409 `already_yours`.
 */
export const JoinLinkResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pair"), credential: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("joined") }),
]);
export type JoinLinkResult = typeof JoinLinkResult.Type;

/**
 * Where `j5 pair --person` and `j5 auth pairing create` make their link when a server is running
 * for the home, so the change reaches open clients as one made in the app does. Only the CLI's
 * own short-lived session with Manage access may call it.
 */
export const J5_CLI_PAIRING_PATH = "/api/j5/people/pair";

/** The commands' flags, as given. */
export const CliPairingRequest = Schema.Struct({
  person: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(PersonLevel),
  project: Schema.optionalKey(Schema.String),
  thread: Schema.optionalKey(Schema.String),
  /** `--scope`, or the command's default; `scopesGiven` says whether it was given. */
  scopes: Schema.Array(AuthGrantScope),
  scopesGiven: Schema.Boolean,
  ttlMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  label: Schema.optionalKey(Schema.String),
  /** What a link without `--person` is: refused, or one for a device the server will ask about. */
  withoutPerson: Schema.Literals(["refuse", "ask"]),
});
export type CliPairingRequest = typeof CliPairingRequest.Type;

/**
 * The link made, and what the command says it did. A refusal carries a status, `error` (the
 * refusal's tag) and `message`; `PairingPersonUnknownError` also carries `personName`.
 */
export const CliPairingResponse = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  scopes: Schema.Array(AuthEnvironmentScope),
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  said: Schema.String,
});
export type CliPairingResponse = typeof CliPairingResponse.Type;

const PeopleError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);
const Done = Schema.Struct({});

export const J5PeopleRpcGroup = RpcGroup.make(
  Rpc.make(J5_PEOPLE_WS_METHODS.listPeople, {
    payload: Schema.Struct({}),
    success: PeopleList,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.listScopePeople, {
    payload: ScopePeopleRequest,
    success: ScopePeople,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges, {
    payload: ScopePeopleRequest,
    success: ScopePeopleChange,
    error: PeopleError,
    stream: true,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.setLevel, {
    payload: SetLevelRequest,
    success: Done,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.removeLevel, {
    payload: RemoveLevelRequest,
    success: Done,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.removePerson, {
    payload: PersonIdRequest,
    success: Done,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.renamePerson, {
    payload: RenamePersonRequest,
    success: Done,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.renameSelf, {
    payload: RenameSelfRequest,
    success: Done,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.revokeDevice, {
    payload: DeviceRequest,
    success: Done,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.createLink, {
    payload: CreateLinkRequest,
    success: PeopleLink,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.listLinks, {
    payload: Schema.Struct({}),
    success: PeopleLinks,
    error: PeopleError,
  }),
  Rpc.make(J5_PEOPLE_WS_METHODS.revokeLink, {
    payload: LinkIdRequest,
    success: Done,
    error: PeopleError,
  }),
);
