/**
 * The Settings pages shown to someone who owns no connected server (People and access AC28,
 * AC29): the pages about their own device, and People with their own row. Everything else is an
 * Owner's, so a page upstream adds later is shown to Owners only until someone decides otherwise.
 */
export const PAGES_FOR_EVERYONE: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/snap-shot",
  "/settings/open-source-licenses",
  "/settings/people",
]);

export const LICENSES_PATH = "/settings/open-source-licenses";

/**
 * Whether the person owns a connected server, or `"loading"` until that is known: the catalog has
 * not been read, it lists no server yet, or no server has said they own it while one is still
 * being asked. The catalog is read before the client's own server is added to it, so an empty one
 * is a client still starting; a web or desktop client always has its own server. While loading,
 * Settings lists what it lists anyone, so nobody sees an Owner's list before their answer.
 */
export function ownerSomewhereState(input: {
  readonly catalogReady: boolean;
  /** Each server's answer; `null` for one still being asked. */
  readonly answers: ReadonlyArray<"owner" | "other" | null>;
}): boolean | "loading" {
  if (!input.catalogReady || input.answers.length === 0) return "loading";
  if (input.answers.includes("owner")) return true;
  return input.answers.includes(null) ? "loading" : false;
}

/** Whether Settings shows a page, by its path. */
export const settingsPageShown = (input: {
  readonly path: string;
  readonly ownerSomewhere: boolean;
}) => input.ownerSomewhere || PAGES_FOR_EVERYONE.has(input.path);

/**
 * Settings' navigation as a person sees it. An Owner sees upstream's list. Anyone else sees the
 * pages they are shown, and Open-source licenses, which upstream reaches only from General, as a
 * page of its own.
 */
export function settingsNavItems<Item extends { readonly to: string }>(
  items: ReadonlyArray<Item>,
  ownerSomewhere: boolean,
  licenses: Item,
): ReadonlyArray<Item> {
  if (ownerSomewhere) return items;
  return [...items.filter((item) => PAGES_FOR_EVERYONE.has(item.to)), licenses];
}

/**
 * What an Owner-only Settings page says, in its place, to someone who reaches it by a link or its
 * address and owns no connected server. Someone who writes nowhere has no agent to ask.
 */
export function ownerOnlySettingsNotice(input: {
  readonly serverName: string | null;
  readonly writesSomewhere: boolean;
}): { readonly title: string; readonly body: string } {
  const server = input.serverName ?? "this server";
  return {
    title: "Coming soon",
    body: input.writesSomewhere
      ? `Only an Owner of ${server} can change this here for now. Ask an Owner, or ask an agent on a thread you can write to.`
      : `Only an Owner of ${server} can change this here for now. Ask an Owner.`,
  };
}
