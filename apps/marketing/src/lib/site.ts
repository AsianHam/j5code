export const GITHUB_REPOSITORY_URL = "https://github.com/Jacksondr5/j5code";
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const LICENSE_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/LICENSE`;
export const PRODUCT_DOCS_URL = `${GITHUB_REPOSITORY_URL}/tree/j5/main/docs/j5/product`;
export const FORK_DISCIPLINE_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/FORK.md`;
/** The register of places J5 deliberately differs from upstream's product. */
export const DIVERGENCES_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/docs/j5/product/upstream.md`;

export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";
export const UPSTREAM_MAIN_URL = `${UPSTREAM_REPOSITORY_URL}/tree/main`;
/** Upstream's contribution guide, which says what they will take from outside. */
export const UPSTREAM_CONTRIBUTING_URL = `${UPSTREAM_REPOSITORY_URL}/blob/main/CONTRIBUTING.md`;
/** Upstream's orchestrator rewrite, the branch stable releases tracked until it merged to main. */
export const UPSTREAM_V2_BRANCH = "t3code/codex-turn-mapping";
export const UPSTREAM_V2_PR_URL = `${UPSTREAM_REPOSITORY_URL}/pull/2829`;
export const T3_SITE_URL = "https://t3.codes";

export const SITE_URL = "https://j5.codes";
export const CONTACT_EMAIL = "hello@j5.codes";
/**
 * The self-contained server for macOS (Apple silicon) and Linux x64; no Node
 * needed. The site serves the installer itself (staged from scripts/install.sh
 * at build time), which in turn fetches the release archive from GitHub.
 */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/install.sh | sh`;
export const INSTALL_DOCS_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/docs/user/install.md`;

/** Status words used on every card. Copy must not claim more than the word allows. */
export type ShipStatus = "underway" | "charted" | "horizon";

export const STATUS_LABEL: Record<ShipStatus, string> = {
  underway: "Shipped",
  charted: "Charted",
  horizon: "Horizon",
};

export const STATUS_HELP: Record<ShipStatus, string> = {
  underway: "Ready to use",
  charted: "In dry dock, being built",
  horizon: "On our roadmap",
};
