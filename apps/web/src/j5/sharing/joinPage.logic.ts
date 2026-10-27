import type { LinkDescription, LinkOpens, PersonLevel } from "@t3tools/contracts/j5";

import { levelLabel } from "./people.logic";

/** What a person is being invited to, as the join page says it (AC42). */
export interface Invitation {
  readonly before: string;
  /** The thing itself, set in bold; `null` for the whole server, which is named in the title. */
  readonly title: string | null;
  readonly after: string;
  /** The level, drawn as a small tag; `null` for a link that adds a device. */
  readonly level: string | null;
  /** What a Viewer is told they can do. */
  readonly viewerNote: string | null;
}

const VIEWER_NOTE = "You can read it and watch the agent work; you cannot send it anything.";

const opensWords = (opens: LinkOpens) =>
  opens.kind === "server"
    ? { title: null, after: "" }
    : opens.kind === "project"
      ? { title: opens.projectTitle, after: "" }
      : {
          title: opens.threadTitle,
          after: opens.projectTitle === null ? "" : ` in ${opens.projectTitle}`,
        };

/** "You have been invited to <thread> in <project> as a [Collaborator]." */
export function invitationFor(description: LinkDescription): Invitation {
  if (description.kind === "device") {
    return {
      before: `This link pairs this device as ${description.personName ?? "someone"} on ${description.serverName}.`,
      title: null,
      after: "",
      level: null,
      viewerNote: null,
    };
  }
  const { title, after } = opensWords(description.opens);
  const level = description.level;
  return {
    before:
      title === null
        ? `You have been invited to ${description.serverName}`
        : "You have been invited to ",
    title,
    after: `${after} as ${level === "owner" ? "an" : "a"}`,
    level: level === null ? null : levelLabel(level),
    viewerNote: level === "viewer" ? VIEWER_NOTE : null,
  };
}

/** What the page shows for a link before anything is spent. */
export type JoinPageState =
  /** Not a J5 link, or nothing can be said of it: upstream's pairing page takes it. */
  | { readonly kind: "upstream" }
  | { readonly kind: "dead" }
  | { readonly kind: "described"; readonly description: LinkDescription };

/** How long the page waits to be told what a link opens before upstream's page takes it. */
export const DESCRIBE_TIMEOUT_MS = 5_000;

/**
 * What the pairing page does with a link. Only a link carrying J5's mark is J5's: every link J5
 * makes carries it, and an ordinary pairing link is handed to upstream's page at once, with no
 * request made about it. A marked link the server describes gets J5's page; one the server
 * refuses to describe does not work, one state whatever the reason (AC42); and when the server
 * cannot be asked or does not answer in time (`status` is `null`), upstream's page takes it.
 */
export function joinPageState(input: {
  readonly marked: boolean;
  readonly status: number | null;
  readonly body: unknown;
}): JoinPageState {
  if (!input.marked) return { kind: "upstream" };
  if (input.status === 200 && isDescription(input.body)) {
    return { kind: "described", description: input.body };
  }
  if (input.status === 404) return { kind: "dead" };
  return { kind: "upstream" };
}

/**
 * What the page asks of the person, from what the browser already is on the server (design §4):
 * a name to give, prefilled for a link that names someone; nothing for a browser already on the
 * server joining a link for many (AC33); or a refusal that leaves the link usable (AC32, AC43).
 */
export type JoinView =
  | { readonly kind: "name"; readonly prefill: string; readonly placeholder: string | null }
  | { readonly kind: "confirm" }
  | { readonly kind: "as-yourself"; readonly name: string | null }
  | { readonly kind: "someone-elses"; readonly name: string | null }
  | { readonly kind: "already-yours" };

export function joinView(description: LinkDescription): JoinView {
  const { device } = description;
  if (description.use === "one" && device.state === "paired") {
    return device.samePerson
      ? { kind: "already-yours" }
      : { kind: "someone-elses", name: description.personName };
  }
  if (description.use === "many" && device.state === "paired") {
    return { kind: "as-yourself", name: device.name };
  }
  // A device link pairs a further device of someone already on the server, under their name.
  if (description.kind === "device") return { kind: "confirm" };
  return description.personName === null
    ? {
        kind: "name",
        prefill: "",
        placeholder: `What should people and agents on ${description.serverName} call you?`,
      }
    : { kind: "name", prefill: description.personName, placeholder: null };
}

/**
 * The refusals the join route answers with a reason the page words itself. `invalid_request` is
 * a join without a name where one is needed, as when the browser joining as itself turns out to
 * be no one's: the page then asks for a name.
 */
export type JoinRefusal =
  | "dead"
  | "name_taken"
  | "paired_as_someone_else"
  | "already_yours"
  | "invalid_request";

export function joinRefusal(status: number, body: unknown): JoinRefusal | null {
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { readonly error: unknown }).error
      : null;
  if (status === 404) return "dead";
  if (status === 400 && error === "invalid_request") return "invalid_request";
  if (status === 409 && error === "name_taken") return "name_taken";
  if (status === 409 && error === "paired_as_someone_else") return "paired_as_someone_else";
  if (status === 409 && error === "already_yours") return "already_yours";
  return null;
}

/** "Someone on openclaw already has that name." and the rest, by refusal. */
export function refusalWords(refusal: JoinRefusal, description: LinkDescription): string {
  switch (refusal) {
    case "dead":
      return "This link does not work. It may have been used, expired or revoked. Ask whoever sent it for a new one.";
    case "name_taken":
      return `Someone on ${description.serverName} already has that name.${nameTakenAdvice(description)}`;
    case "paired_as_someone_else":
      return someoneElsesWords(description.personName);
    case "already_yours":
      return ALREADY_YOURS;
    case "invalid_request":
      return "Give the name people and agents should call you, then join.";
  }
}

/**
 * What to do when the name taken is the person's own. A browser already on the server joins a
 * link for many as itself, but is turned away by a link for one person.
 */
const nameTakenAdvice = (description: LinkDescription) =>
  description.kind === "device"
    ? ""
    : description.use === "many"
      ? " If it is yours, open the link on the device you paired before, or ask for a link for this device."
      : " If it is yours, ask whoever sent this link for a link for this device.";

export const ALREADY_YOURS =
  "This device is already yours. Open the link on the device you want to add.";

export const someoneElsesWords = (name: string | null) =>
  name === null
    ? "This link is for someone new, and this device is already someone's. Send it to them."
    : `This link is for ${name}. Send it to them.`;

/** "This link adds <thread> as a Viewer." for a browser already on the server (AC33). */
export function asYourselfWords(description: LinkDescription, name: string | null): string {
  const { title } = opensWords(description.opens);
  const level: PersonLevel = description.level ?? "viewer";
  const who = name === null ? "" : ` as ${name}`;
  // A name that ends in a full stop, "Priya K.", ends the sentence itself.
  const stop = who.endsWith(".") ? "" : ".";
  return `You are already on ${description.serverName}${who}${stop} This link adds ${title ?? "the whole server"} as a ${levelLabel(level)}.`;
}

function isDescription(body: unknown): body is LinkDescription {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Partial<LinkDescription>;
  return (
    (value.kind === "device" || value.kind === "invite") &&
    (value.use === "one" || value.use === "many") &&
    typeof value.serverName === "string" &&
    typeof value.opens === "object" &&
    value.opens !== null &&
    typeof value.device === "object" &&
    value.device !== null
  );
}
