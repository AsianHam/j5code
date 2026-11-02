import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderSelection } from "../../components/ChatView.logic";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { composerProviderCandidates } from "./personaComposerSelection";

describe("composerProviderCandidates", () => {
  const provider = (driver: string, command: string) =>
    deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(driver),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-31T00:00:00.000Z",
        models: [],
        slashCommands: [{ name: command }],
        skills: [],
      } satisfies ServerProvider,
    ])[0]!;
  const entries = [provider("claudeAgent", "advisor"), provider("codex", "review")];
  const codexAgent = {
    personaId: "luna-helper",
    definitionVersion: 1,
    authorityPolicy: "read-only" as const,
    resolvedRoute: "primary" as const,
    resolvedDriver: ProviderDriverKind.make("codex"),
    resolvedModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  };
  const selectedFor = (agent: typeof codexAgent | undefined) =>
    resolveComposerProviderSelection({
      entries,
      candidateInstanceIds: composerProviderCandidates(agent, [
        ProviderInstanceId.make("claudeAgent"),
      ]),
      lockedProvider: null,
      lockedInstanceId: undefined,
    }).selectedProviderEntry?.snapshot;

  it("offers a saved agent's provider commands, not the draft's earlier pick", () => {
    expect(selectedFor(codexAgent)?.slashCommands).toEqual([{ name: "review" }]);
  });

  it("leaves a draft without a saved agent on its own pick", () => {
    expect(selectedFor(undefined)?.slashCommands).toEqual([{ name: "advisor" }]);
  });
});
