// Settings pages a guest has no use for. Scheduled Tasks, Source Control and Archive are
// upstream's and only show a guest a failure, since each asks the server for something a guest is
// not given; a guest who types one of their addresses still gets upstream's error. Personas and
// Skills are J5's and say plainly that they are not available to a guest.
const HIDDEN_FROM_A_GUEST: ReadonlySet<string> = new Set([
  "/settings/scheduled-tasks",
  "/settings/source-control",
  "/settings/archived",
  "/settings/personas",
  "/settings/skills",
]);

/**
 * Whether Settings lists a section. People is about the primary server, and is listed for a
 * connection that can see who is on it. The pages a guest has no use for are left out only for
 * a person who is a guest on every server they are connected to: someone who is a guest on one
 * server and a member of another keeps every page, for the server that is theirs.
 */
export function settingsNavShown(input: {
  readonly path: string;
  readonly canSeePeople: boolean;
  readonly guestEverywhere: boolean;
}): boolean {
  if (input.path === "/settings/people") return input.canSeePeople;
  return !(input.guestEverywhere && HIDDEN_FROM_A_GUEST.has(input.path));
}
