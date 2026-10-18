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

/** Where Settings opens for someone who owns no connected server. */
export const FIRST_PAGE_FOR_EVERYONE = "/settings/appearance";

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
