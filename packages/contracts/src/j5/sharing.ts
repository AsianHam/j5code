import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthClientMetadata, EnvironmentAuthorizationError } from "../auth.ts";
import { AuthSessionId, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProjectIconOverride } from "../project.ts";
import { J5ActionError } from "./actionError.ts";

/**
 * What a connection is told about its own place on a shared server
 * (docs/j5/product/features/shared-server.md). A member's connection reaches everything, so it is
 * told once that it is a member's and asks nothing more. A guest's is told the level it holds on
 * each thread it opens, worked out by the server: a grant covers the agents beneath a thread and
 * the threads of a granted project, which a client cannot tell from the grants themselves.
 */
export const J5_SHARING_WS_METHODS = {
  getConnectionAccess: "j5.sharing.getConnectionAccess",
  subscribeThreadAccess: "j5.sharing.subscribeThreadAccess",
  // What a guest's own connection may ask about and do with its own grants.
  listOwnGrants: "j5.sharing.listOwnGrants",
  leaveGrant: "j5.sharing.leaveGrant",
  // What a member who manages access does (Shared server AC17 to AC20).
  listPeople: "j5.sharing.listPeople",
  createGuest: "j5.sharing.createGuest",
  putGrant: "j5.sharing.putGrant",
  removeGrant: "j5.sharing.removeGrant",
  removePerson: "j5.sharing.removePerson",
  revokeDevice: "j5.sharing.revokeDevice",
  createLink: "j5.sharing.createLink",
  renamePerson: "j5.sharing.renamePerson",
  // Names the person the server belongs to, whom guests and agents know by that name.
  setOwnerName: "j5.sharing.setOwnerName",
  // Who can reach one thread, for anyone who can reach it themselves.
  listThreadPeople: "j5.sharing.listThreadPeople",
  subscribeThreadPeopleChanges: "j5.sharing.subscribeThreadPeopleChanges",
  revokeLink: "j5.sharing.revokeLink",
  // A view-only link several people can join one thread with.
  listOpenLinks: "j5.sharing.listOpenLinks",
  createOpenLink: "j5.sharing.createOpenLink",
  revokeOpenLink: "j5.sharing.revokeOpenLink",
} as const;

/** Where a person who opens an open link joins. It needs no sign-in, as pairing does not. */
export const SHARING_JOIN_PATH = "/api/j5/sharing/join";

export const SharingConnectionKind = Schema.Literals(["member", "guest"]);
export type SharingConnectionKind = typeof SharingConnectionKind.Type;

/** The level a guest holds on one thread; `none` when no grant covers it. */
export const SharingThreadLevel = Schema.Literals(["view", "collaborate", "none"]);
export type SharingThreadLevel = typeof SharingThreadLevel.Type;

export const SharingConnectionAccess = Schema.Struct({
  kind: SharingConnectionKind,
  /**
   * The name of the person the server belongs to, told to a member's connection: `null` until
   * one is set, which is how a client knows at startup to ask for it. A guest's connection is
   * not told it here; it reads the owner's name as one of the people on a thread it can see.
   */
  ownerName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type SharingConnectionAccess = typeof SharingConnectionAccess.Type;

export const SharingThreadAccessRequest = Schema.Struct({ threadId: ThreadId });
export type SharingThreadAccessRequest = typeof SharingThreadAccessRequest.Type;

export const SharingThreadAccess = Schema.Struct({
  kind: SharingConnectionKind,
  /** A member's connection is not held to a level, and is always told `collaborate`. */
  level: SharingThreadLevel,
});
export type SharingThreadAccess = typeof SharingThreadAccess.Type;

export class SharingAccessError extends Schema.TaggedError<SharingAccessError>()(
  "SharingAccessError",
  { message: Schema.String },
) {}

/** A person on a shared server: a member reaches everything, a guest what their grants cover. */
export const SharingPersonKind = Schema.Literals(["member", "guest"]);
export type SharingPersonKind = typeof SharingPersonKind.Type;

/** The level a grant gives: read, or also write to the agent. */
export const SharingGrantLevel = Schema.Literals(["view", "collaborate"]);
export type SharingGrantLevel = typeof SharingGrantLevel.Type;

/** What a grant is on: a whole project, or one thread and the agents beneath it. */
export const SharingGrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type SharingGrantTarget = typeof SharingGrantTarget.Type;

// What a person's name may not hold: control characters, line and paragraph separators, and
// every character that draws nothing or was never assigned. That takes in the marks that turn or
// isolate the direction of text, zero-width characters, the soft hyphen and the invisible tag
// characters, which a member cannot see and a model reads as plain letters. Emoji joined by a
// zero-width joiner go with them: a name does not need them, and one plain rule is worth more.
//
// Square brackets go too. A person's name is written into the line that tells an agent who a
// message is from, `[Message from Priya (guest)]`, and a name holding a bracket could make that
// line read as two. Parentheses stay: people write names like "Sam (QA)".
const NOT_IN_A_PERSON_NAME = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}[\]]/u;
// An accent or a vowel sign is one or two marks on a letter; a longer run stacks marks to draw
// over the lines around it.
const TOO_MANY_MARKS = /\p{M}{3,}/u;

/**
 * Whether a person's name is one line of visible, ordinary characters, up to 80 of them, with
 * no square brackets. A name
 * is shown to everyone on a shared thread and goes on that person's messages to an agent, so it
 * is held to this whoever typed it.
 */
export const isPersonName = (name: string) =>
  name.trim().length > 0 &&
  name.length <= 80 &&
  !NOT_IN_A_PERSON_NAME.test(name) &&
  !TOO_MANY_MARKS.test(name);

/** A person's name: what they are called everywhere on the server. */
export const SharingPersonName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.makeFilter((name: string) => isPersonName(name), {
    title: "one line of visible characters, with no square brackets",
  }),
);

/** The optional line a member writes when sharing, saying what the guest is there for. */
export const SharingGrantNote = TrimmedNonEmptyString.check(Schema.isMaxLength(280));

export const SharingGrant = Schema.Struct({
  target: SharingGrantTarget,
  level: SharingGrantLevel,
  note: Schema.NullOr(Schema.String),
});
export type SharingGrant = typeof SharingGrant.Type;

/** One device paired as a person: a session, as upstream's own list of clients describes it. */
export const SharingDevice = Schema.Struct({
  sessionId: AuthSessionId,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
});
export type SharingDevice = typeof SharingDevice.Type;

/** A share link made for a person and not used yet. The credential is shown only when it is made. */
export const SharingPendingLink = Schema.Struct({
  linkId: TrimmedNonEmptyString,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type SharingPendingLink = typeof SharingPendingLink.Type;

/**
 * A person as the People page lists them. A member holds no grants. A member's devices are not
 * listed here: a session that is not a guest's belongs to no particular member, and upstream's own
 * list of clients shows them.
 */
export const SharingPerson = Schema.Struct({
  personId: TrimmedNonEmptyString,
  kind: SharingPersonKind,
  displayName: Schema.NullOr(Schema.String),
  /**
   * The person the asking connection is. Every connection that is not a guest's is the one
   * member there is, and only such a connection is told of people, so this is the member's row.
   */
  you: Schema.Boolean,
  /** The person typed this name themselves, joining by an open link; no member has confirmed it. */
  nameSelfGiven: Schema.Boolean,
  /** The open link the person joined through, when they did. */
  joinedOpenLinkId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  grants: Schema.Array(SharingGrant),
  devices: Schema.Array(SharingDevice),
  pendingLinks: Schema.Array(SharingPendingLink),
});
export type SharingPerson = typeof SharingPerson.Type;

export const SharingPeople = Schema.Struct({ people: Schema.Array(SharingPerson) });
export type SharingPeople = typeof SharingPeople.Type;

/** A grant as the guest who holds it is told of it: what it is on and its level. */
export const SharingOwnGrant = Schema.Struct({
  target: SharingGrantTarget,
  level: SharingGrantLevel,
});
export type SharingOwnGrant = typeof SharingOwnGrant.Type;

export const SharingOwnGrants = Schema.Struct({ grants: Schema.Array(SharingOwnGrant) });
export type SharingOwnGrants = typeof SharingOwnGrants.Type;

export const SharingCreateGuestRequest = Schema.Struct({ displayName: SharingPersonName });
export type SharingCreateGuestRequest = typeof SharingCreateGuestRequest.Type;

export const SharingPutGrantRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  target: SharingGrantTarget,
  level: SharingGrantLevel,
  /** Left out, the grant keeps the line it has; `null` clears it. */
  note: Schema.optionalKey(Schema.NullOr(SharingGrantNote)),
});
export type SharingPutGrantRequest = typeof SharingPutGrantRequest.Type;

export const SharingGrantRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  target: SharingGrantTarget,
});
export type SharingGrantRequest = typeof SharingGrantRequest.Type;

export const SharingPersonRequest = Schema.Struct({ personId: TrimmedNonEmptyString });
export type SharingPersonRequest = typeof SharingPersonRequest.Type;

/** How long a link can be used for once made. The dialogs offer exactly these. */
export const SharingLinkLifetime = Schema.Literals(["1h", "24h", "7d", "30d"]);
export type SharingLinkLifetime = typeof SharingLinkLifetime.Type;

export const SharingCreateLinkRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  /** Left out, the link lasts seven days. */
  lifetime: Schema.optionalKey(SharingLinkLifetime),
});
export type SharingCreateLinkRequest = typeof SharingCreateLinkRequest.Type;

export const SharingRenamePersonRequest = Schema.Struct({
  personId: TrimmedNonEmptyString,
  displayName: SharingPersonName,
});
export type SharingRenamePersonRequest = typeof SharingRenamePersonRequest.Type;

/**
 * How a person comes to reach a thread: a grant on the thread itself, on a thread above it (it
 * is an agent beneath a shared thread), or on its project.
 */
export const SharingReachVia = Schema.Literals(["thread", "ancestor", "project"]);
export type SharingReachVia = typeof SharingReachVia.Type;

/**
 * A guest who can reach a thread. `level` is what they hold on it, the highest of `grants`.
 * `personId` is told to a member, who acts on the person by it; a guest asking is told `null`.
 */
export const SharingThreadGuest = Schema.Struct({
  personId: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  level: SharingGrantLevel,
  grants: Schema.Array(Schema.Struct({ via: SharingReachVia, level: SharingGrantLevel })),
  /** The guest who is asking. */
  you: Schema.Boolean,
  /** They typed this name themselves, joining by an open link; no member has confirmed it. */
  nameSelfGiven: Schema.Boolean,
  /** They joined by an open link. */
  joinedByOpenLink: Schema.Boolean,
});
export type SharingThreadGuest = typeof SharingThreadGuest.Type;

/**
 * Who can reach one thread. Members reach every thread and hold no level; a member has a name
 * only if the server recorded one, which today it does for none, so a client words a nameless
 * member itself. Nothing here says what else anyone reaches, or anything of their devices or
 * links.
 */
export const SharingThreadPeople = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      personId: Schema.NullOr(Schema.String),
      displayName: Schema.NullOr(Schema.String),
    }),
  ),
  guests: Schema.Array(SharingThreadGuest),
  /**
   * The thread's open links that can still be joined with, newest first. Told to a member's
   * connection; a guest asking is told none.
   */
  openLinks: Schema.Array(
    Schema.Struct({
      linkId: Schema.String,
      expiresAt: Schema.DateTimeUtc,
      joined: Schema.Number,
    }),
  ),
});
export type SharingThreadPeople = typeof SharingThreadPeople.Type;

/** Moves each time the answer of `listThreadPeople` for that thread changes. It says no more. */
export const SharingThreadPeopleChange = Schema.Struct({ revision: Schema.Number });
export type SharingThreadPeopleChange = typeof SharingThreadPeopleChange.Type;

export const SharingDeviceRequest = Schema.Struct({ sessionId: AuthSessionId });
export type SharingDeviceRequest = typeof SharingDeviceRequest.Type;

export const SharingLinkRequest = Schema.Struct({ linkId: TrimmedNonEmptyString });
export type SharingLinkRequest = typeof SharingLinkRequest.Type;

export const SharingLeaveGrantRequest = Schema.Struct({ target: SharingGrantTarget });
export type SharingLeaveGrantRequest = typeof SharingLeaveGrantRequest.Type;

/**
 * A share link for one person. `credential` is one of upstream's single-use pairing credentials: a
 * client turns it into a link the way it does any pairing credential, over a route by which the
 * server is already reachable (AC22). It pairs one device as that person and is not shown again.
 */
export const SharingLink = Schema.Struct({
  linkId: TrimmedNonEmptyString,
  personId: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type SharingLink = typeof SharingLink.Type;

/**
 * The mark J5 puts on every share link it makes, in the fragment beside upstream's `token`. The
 * page that opens the link reads it to know the link is a guest's before asking the server
 * anything, so a share link that no longer works is told apart from a pairing token the server
 * simply does not describe. Upstream reads the fragment as parameters and takes only `token`.
 */
const SHARE_LINK_MARK = "j5share";

/**
 * A pairing address marked as a share link's. Everything that hands out a share link marks it
 * here: the Share dialog, and the live-test rig's `guest` command.
 */
export function markedAsShareLink(address: string): string {
  const url = new URL(address);
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  fragment.set(SHARE_LINK_MARK, "1");
  url.hash = fragment.toString();
  return url.toString();
}

/** Whether an address carries J5's mark. */
export function isMarkedShareLink(address: string): boolean {
  try {
    return new URLSearchParams(new URL(address).hash.replace(/^#/u, "")).has(SHARE_LINK_MARK);
  } catch {
    return false;
  }
}

/** An open link as a member sees it. Its token is shown only when it is made. */
export const SharingOpenLink = Schema.Struct({
  linkId: TrimmedNonEmptyString,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  revoked: Schema.Boolean,
  /** The people who joined through it, oldest first. */
  joined: Schema.Array(Schema.String),
});
export type SharingOpenLink = typeof SharingOpenLink.Type;

export const SharingOpenLinks = Schema.Struct({ links: Schema.Array(SharingOpenLink) });

export const SharingCreatedOpenLink = Schema.Struct({
  ...SharingOpenLink.fields,
  token: TrimmedNonEmptyString,
});
export type SharingCreatedOpenLink = typeof SharingCreatedOpenLink.Type;

export const SharingCreateOpenLinkRequest = Schema.Struct({
  threadId: ThreadId,
  /** Left out, the link lasts seven days. */
  lifetime: Schema.optionalKey(SharingLinkLifetime),
});
export type SharingCreateOpenLinkRequest = typeof SharingCreateOpenLinkRequest.Type;

export const SharingOpenLinkRequest = Schema.Struct({ linkId: TrimmedNonEmptyString });
export type SharingOpenLinkRequest = typeof SharingOpenLinkRequest.Type;

/** Where a client asks what a link opens before using it. It needs no sign-in and spends nothing. */
export const SHARING_DESCRIBE_PATH = "/api/j5/sharing/describe";

/** A share link's credential or an open link's token, sent in the body and never in a URL. */
export const SharingDescribeRequest = Schema.Struct({
  link: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type SharingDescribeRequest = typeof SharingDescribeRequest.Type;

/** One thing a link opens, by the names a person would know it by. */
export const SharingLinkOpens = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadTitle: Schema.String,
    projectTitle: Schema.NullOr(Schema.String),
    /** The icon a person chose for the thread's project, when they chose one. */
    projectIcon: Schema.NullOr(ProjectIconOverride),
    /**
     * A link to the project's favicon file, relative to the server, when the project has one and
     * no chosen icon. It is J5's own signed link, good for an hour, and names no folder. A client
     * draws `projectIcon` when there is one, then this, then its default.
     */
    projectFaviconUrl: Schema.NullOr(Schema.String),
    level: SharingGrantLevel,
  }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectTitle: Schema.String,
    projectIcon: Schema.NullOr(ProjectIconOverride),
    /**
     * A link to the project's favicon file, relative to the server, when the project has one and
     * no chosen icon. It is J5's own signed link, good for an hour, and names no folder. A client
     * draws `projectIcon` when there is one, then this, then its default.
     */
    projectFaviconUrl: Schema.NullOr(Schema.String),
    level: SharingGrantLevel,
  }),
]);
export type SharingLinkOpens = typeof SharingLinkOpens.Type;

/**
 * What a link that would work right now opens. A link for a named person says who it is for and
 * what that person can reach, which may be nothing yet. An open link says the one thread it gives
 * View on. It names no ids, no paths, no one who shared it and no one who has joined.
 */
export const SharingLinkDescription = Schema.Struct({
  kind: Schema.Literals(["person", "open"]),
  serverName: Schema.String,
  /** The name the member gave the person a named link is for; `null` for an open link. */
  personName: Schema.NullOr(Schema.String),
  opens: Schema.Array(SharingLinkOpens),
  /** When the link stops working if it is not used first. */
  expiresAt: Schema.DateTimeUtc,
});
export type SharingLinkDescription = typeof SharingLinkDescription.Type;

/** What a person sends to join: the link's token and the name they go by. */
export const SharingJoinRequest = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  displayName: SharingPersonName,
});
export type SharingJoinRequest = typeof SharingJoinRequest.Type;

const ManageError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);
const Done = Schema.Struct({});

export const J5SharingRpcGroup = RpcGroup.make(
  Rpc.make(J5_SHARING_WS_METHODS.getConnectionAccess, {
    payload: Schema.Struct({}),
    success: SharingConnectionAccess,
    error: Schema.Union([SharingAccessError, EnvironmentAuthorizationError]),
  }),
  // The current level, then the new one each time a change to the guest's grants alters it.
  Rpc.make(J5_SHARING_WS_METHODS.subscribeThreadAccess, {
    payload: SharingThreadAccessRequest,
    success: SharingThreadAccess,
    error: Schema.Union([SharingAccessError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  // The grants the asking connection's own guest holds; a member's connection holds none.
  Rpc.make(J5_SHARING_WS_METHODS.listOwnGrants, {
    payload: Schema.Struct({}),
    success: SharingOwnGrants,
    error: ManageError,
  }),
  // A guest gives up one grant it holds (AC25). Coming back takes a new grant from a member.
  Rpc.make(J5_SHARING_WS_METHODS.leaveGrant, {
    payload: SharingLeaveGrantRequest,
    success: Done,
    error: ManageError,
  }),
  Rpc.make(J5_SHARING_WS_METHODS.listPeople, {
    payload: Schema.Struct({}),
    success: SharingPeople,
    error: ManageError,
  }),
  Rpc.make(J5_SHARING_WS_METHODS.createGuest, {
    payload: SharingCreateGuestRequest,
    success: SharingPerson,
    error: ManageError,
  }),
  // Adds a grant, or changes the level or the line of one the person already holds.
  Rpc.make(J5_SHARING_WS_METHODS.putGrant, {
    payload: SharingPutGrantRequest,
    success: SharingPerson,
    error: ManageError,
  }),
  Rpc.make(J5_SHARING_WS_METHODS.removeGrant, {
    payload: SharingGrantRequest,
    success: SharingPerson,
    error: ManageError,
  }),
  // Removes a guest altogether: their grants, their devices and their unused links.
  Rpc.make(J5_SHARING_WS_METHODS.removePerson, {
    payload: SharingPersonRequest,
    success: Done,
    error: ManageError,
  }),
  // Ends one device of a guest's. The person and their grants stay.
  Rpc.make(J5_SHARING_WS_METHODS.revokeDevice, {
    payload: SharingDeviceRequest,
    success: Done,
    error: ManageError,
  }),
  // A link for a new person's first device, or a further device of someone already here.
  Rpc.make(J5_SHARING_WS_METHODS.createLink, {
    payload: SharingCreateLinkRequest,
    success: SharingLink,
    error: ManageError,
  }),
  Rpc.make(J5_SHARING_WS_METHODS.setOwnerName, {
    payload: SharingCreateGuestRequest,
    success: SharingPerson,
    error: ManageError,
  }),
  // Renaming also confirms: a name a member typed is no longer one the guest gave themselves.
  Rpc.make(J5_SHARING_WS_METHODS.renamePerson, {
    payload: SharingRenamePersonRequest,
    success: SharingPerson,
    error: ManageError,
  }),
  // Who can reach a thread. A guest may ask it of a thread its own grants cover.
  Rpc.make(J5_SHARING_WS_METHODS.listThreadPeople, {
    payload: SharingThreadAccessRequest,
    success: SharingThreadPeople,
    error: ManageError,
  }),
  // A count that moves when that answer changes, so a client knows to ask again.
  Rpc.make(J5_SHARING_WS_METHODS.subscribeThreadPeopleChanges, {
    payload: SharingThreadAccessRequest,
    success: SharingThreadPeopleChange,
    error: ManageError,
    stream: true,
  }),
  // Cancels a share link that has not been used yet.
  Rpc.make(J5_SHARING_WS_METHODS.revokeLink, {
    payload: SharingLinkRequest,
    success: Done,
    error: ManageError,
  }),
  Rpc.make(J5_SHARING_WS_METHODS.listOpenLinks, {
    payload: Schema.Struct({}),
    success: SharingOpenLinks,
    error: ManageError,
  }),
  Rpc.make(J5_SHARING_WS_METHODS.createOpenLink, {
    payload: SharingCreateOpenLinkRequest,
    success: SharingCreatedOpenLink,
    error: ManageError,
  }),
  // Stops new people joining; those who already joined are removed one at a time.
  Rpc.make(J5_SHARING_WS_METHODS.revokeOpenLink, {
    payload: SharingOpenLinkRequest,
    success: Done,
    error: ManageError,
  }),
);
