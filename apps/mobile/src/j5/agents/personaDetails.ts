import type { AgentPersonaCatalogRow } from "@t3tools/client-runtime/j5/agent-personas";
import { PROVIDER_DISPLAY_NAMES, type AgentPersonaModelTarget } from "@t3tools/contracts";

export interface PersonaDetailRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: "danger";
}

const modelLabel = (target: AgentPersonaModelTarget) =>
  [
    PROVIDER_DISPLAY_NAMES[target.driver] ?? target.driver,
    target.model,
    target.reasoningEffort,
  ].join(" · ");

/**
 * What the read-only sheet shows for a persona the person can't edit. Models come from the
 * definition, read on open: `null` while it loads, and the catalog's resolved route if it fails.
 */
export function personaDetailRows(
  persona: Pick<
    AgentPersonaCatalogRow,
    | "origin"
    | "originLabel"
    | "authority"
    | "description"
    | "availabilityLabel"
    | "blockedReasons"
    | "route"
  >,
  models:
    | { readonly status: "loading" }
    | { readonly status: "failed" }
    | {
        readonly status: "loaded";
        readonly route: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget];
      },
  usageLine: string | null,
): ReadonlyArray<PersonaDetailRow> {
  const source = persona.origin?.kind === "folder" ? persona.origin.path : persona.originLabel;
  return [
    { label: "Status", value: persona.availabilityLabel },
    ...persona.blockedReasons.map((reason) => ({
      label: "Reason",
      value: reason,
      tone: "danger" as const,
    })),
    ...(source === null ? [] : [{ label: "Source", value: source }]),
    { label: "Access", value: persona.authority },
    ...(models.status === "loaded"
      ? [
          { label: "Primary model", value: modelLabel(models.route[0]) },
          { label: "Fallback model", value: modelLabel(models.route[1]) },
        ]
      : [{ label: "Model", value: models.status === "loading" ? "Loading…" : persona.route }]),
    { label: "Description", value: persona.description },
    ...(usageLine === null ? [] : [{ label: "Usage", value: usageLine }]),
  ];
}
