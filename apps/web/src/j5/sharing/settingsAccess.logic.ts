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

/** Whether Settings shows a page, by its path. */
export const settingsPageShown = (input: {
  readonly path: string;
  readonly ownerSomewhere: boolean;
}) => input.ownerSomewhere || PAGES_FOR_EVERYONE.has(input.path);

export interface SettingsNavGroup<Path extends string> {
  readonly heading: string | null;
  readonly paths: ReadonlyArray<Path>;
}

/**
 * Settings' navigation as a person sees it. An Owner sees upstream's groups. Anyone else sees the
 * pages they are shown, in upstream's groups, and Open-source licenses, which upstream reaches
 * only from About, as a page of its own.
 */
export function settingsNavGroups<Path extends string>(
  groups: ReadonlyArray<SettingsNavGroup<Path>>,
  ownerSomewhere: boolean,
  licenses: Path,
): ReadonlyArray<SettingsNavGroup<Path>> {
  if (ownerSomewhere) return groups;
  return [
    ...groups
      .map((group) => ({
        heading: group.heading,
        paths: group.paths.filter((path) => PAGES_FOR_EVERYONE.has(path)),
      }))
      .filter((group) => group.paths.length > 0),
    { heading: null, paths: [licenses] },
  ];
}
