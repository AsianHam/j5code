import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";

export function useAgentMentionPicker(
  environmentId: EnvironmentId | null,
  provider: string | undefined,
  trigger: { kind: string; query: string } | null,
) {
  const supported = provider === "codex" || provider === "claudeAgent";
  // Explicit `@persona:` lists every launchable persona; a bare `@name` adds only prefix matches
  // above the file results so `@scout` finds Scout without hiding paths.
  const enabled = supported && (trigger?.kind === "agent" || trigger?.kind === "path");
  const catalog = useEnvironmentQuery(
    enabled && environmentId !== null
      ? agentPersonaEnvironment.catalog({ environmentId, input: {} })
      : null,
  );
  const items = enabled
    ? agentPersonaMentionItems(catalog.data, trigger?.query ?? "", {
        matchPrefixOnly: trigger?.kind === "path",
      })
    : [];
  return { items, isPending: catalog.isPending, error: catalog.error };
}
