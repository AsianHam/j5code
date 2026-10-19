import { SkillCatalogError, type SkillCatalogApplyResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { skillChangeFeedback } from "./skillChangeFeedback";

const isSkillCatalogError = Schema.is(Schema.Struct(SkillCatalogError.fields));

/**
 * Pure presentation helpers for Settings → Skills. The component owns
 * environment selection and RPC wiring; everything testable lives here.
 */

/** A source edit is saveable when different from configured; blank disables the catalog. */
export function isSourceSaveable(draft: string, configured: string): boolean {
  const trimmed = draft.trim();
  return trimmed !== configured;
}

/** Surface blocked installations before the counts, including partial success. */
export function summarizeApplyResult(
  result: Pick<SkillCatalogApplyResult, "installed" | "removed" | "unchanged" | "conflicts">,
): string {
  const counts = `Installed ${result.installed} links, removed ${result.removed}, ${result.unchanged} unchanged.`;
  const blocked = result.conflicts.length;
  const summary =
    blocked > 0
      ? `${blocked} skill ${blocked === 1 ? "link was" : "links were"} blocked by existing files or links. ${counts}`
      : counts;
  return result.installed || result.removed ? skillChangeFeedback(summary) : summary;
}

/**
 * Partial apply counts attached to a failed apply error. Guards on the error
 * tag instead of instanceof so a foreign bundle copy still matches.
 */
export function extractPartialApplyResult(cause: unknown): SkillCatalogApplyResult | undefined {
  return isSkillCatalogError(cause) ? cause.result : undefined;
}

/**
 * Drop selected groups the catalog no longer reports (e.g. an Update removed
 * one). Submitting an unknown group would fail, so pruning on fresh status
 * keeps Apply working without a page reset.
 */
export function pruneSelectedGroups(
  selected: ReadonlyArray<string>,
  knownGroups: ReadonlyArray<{ readonly name: string }>,
): Array<string> {
  const known = new Set(knownGroups.map((group) => group.name));
  return selected.filter((name) => known.has(name));
}

/** Whether a status error is the stale-page guard asking for a source reload. */
export function isSourceChangedError(error: unknown): boolean {
  return isSkillCatalogError(error) && error.reason === "source-changed";
}

/** Scope key for per-catalog UI state: selections and results belong to it. */
export function catalogScopeFor(environmentId: string, configuredSource: string): string {
  return `${environmentId}::${configuredSource}`;
}

export interface CatalogActionableInput {
  readonly busy: boolean;
  readonly isPending: boolean;
  readonly hasData: boolean;
  readonly displayedSource: string;
  readonly configuredSource: string;
}

/**
 * Actions (Apply, Update, group toggles) are enabled only when the input
 * shows the configured source and status has loaded for exactly that source.
 * A failed save leaves the draft visible against the old settings, so Apply
 * stays disabled instead of submitting the previous source; an external
 * A → B change disables actions until B's status arrives instead of
 * submitting A.
 */
export function isCatalogActionable(input: CatalogActionableInput): boolean {
  if (input.busy || input.isPending || !input.hasData) return false;
  return input.displayedSource.trim() === input.configuredSource;
}
