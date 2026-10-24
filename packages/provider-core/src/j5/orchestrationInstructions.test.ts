import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "../server/orchestrationInstructions.ts";
import {
  J5_ORCHESTRATION_INSTRUCTIONS,
  J5_ORCHESTRATION_SECTIONS,
} from "./orchestrationInstructions.ts";
import { PLAYBOOK_INSTRUCTIONS } from "./playbookInstructions.ts";

// Codex cuts the middle out of any additionalContext entry over this many UTF-8 bytes; it gets
// each section as its own entry (upstream's CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES).
const CODEX_ENTRY_MAX_BYTES = 4_000;

describe("J5 orchestration instructions", () => {
  it("are what upstream's exported constants carry to every harness", () => {
    assert.strictEqual(T3_CODE_ORCHESTRATION_SECTIONS, J5_ORCHESTRATION_SECTIONS);
    assert.strictEqual(T3_CODE_ORCHESTRATION_INSTRUCTIONS, J5_ORCHESTRATION_INSTRUCTIONS);
    assert.strictEqual(t3OrchestrationSystemPrompt(true), J5_ORCHESTRATION_INSTRUCTIONS);
    assert.isUndefined(t3OrchestrationSystemPrompt(false));
    assert.include(
      t3OrchestrationPromptForFirstRun({ prompt: "Inspect.", runOrdinal: 1, hasT3Mcp: true }),
      J5_ORCHESTRATION_INSTRUCTIONS.trim(),
    );
  });

  it("fit each section whole into one Codex context entry", () => {
    assert.isAbove(J5_ORCHESTRATION_SECTIONS.length, 1);
    for (const [index, section] of J5_ORCHESTRATION_SECTIONS.entries()) {
      const bytes = Buffer.byteLength(section, "utf8");
      assert.isAtMost(
        bytes,
        CODEX_ENTRY_MAX_BYTES,
        `section ${index + 1}: ${bytes} UTF-8 bytes exceeds Codex's ${CODEX_ENTRY_MAX_BYTES}-byte per-entry cap; split it`,
      );
      assert.strictEqual(
        section,
        section.trim(),
        `section ${index + 1} has stray outer whitespace`,
      );
    }
  });

  it("keep every playbook bullet when the playbook guidance is split across sections", () => {
    const bullets = PLAYBOOK_INSTRUCTIONS.trim().split("\n");
    assert.isAbove(bullets.length, 1);
    for (const bullet of bullets) {
      assert.isTrue(
        J5_ORCHESTRATION_SECTIONS.some((section) => section.includes(bullet)),
        bullet.slice(0, 60),
      );
    }
    assert.isTrue(
      J5_ORCHESTRATION_SECTIONS.some((section) =>
        section.startsWith("Playbooks in a Crew:\n\n- As a Captain"),
      ),
    );
  });

  it("brand the ACP mode, browser, and orchestration guidance as J5 Code", () => {
    const prompt = "Inspect the repository.";
    const injected = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true },
    });
    assert.include(injected, "J5 Code interaction mode: Default");
    assert.include(injected, "J5 Code collaborative browser");
    assert.include(injected, "You are running inside J5 Code.");
    assert.include(injected, J5_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.notInclude(injected, "T3 Code");
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { interactionMode: "plan", hasT3Mcp: false },
      }),
      "J5 Code interaction mode: Plan",
    );
  });

  it("carry upstream's model-option and model search rules", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "or when model options are requested or inherited",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "nonempty `inheritedOptions`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "put settings in `target.options`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "report a capability mismatch");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "[] or {} clears them");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Native subagents cannot reliably apply J5 model options",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "It lists a short set of models per provider; pass `search` to find others.",
    );
  });

  it("steers to provider-native Subagents and platform Peer Agents", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "provider-native Subagent");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "your provider's native Subagent mechanism");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Use platform `j5_spawn_agent`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "what should come back in that brief");
    // Crews are the third shape of help; without this bullet an agent asked for a crew makes subagents.
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "A Crew is a group of Peer Agents");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Use `j5_propose_crew`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Use `j5_list_participants`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "later work owed by an existing participant");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "expect_reply=true");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "open an Exchange");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "continue with other work");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`delegate_task` with persona=ID");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`@persona:ID`");
    // Upstream's raw thread tools stay hidden, so its guidance for them is not ported.
    for (const excluded of [
      "task_status",
      "task_cancel",
      "create_threads",
      "t3_thread_start",
      "t3_thread_send",
      "t3_thread_launch",
      "workspace strategy",
      "workspaceStrategy",
      "In your brief, tell the new agent",
      "delegated work must return a result",
      "then use `j5_send_message",
      "cannot create a new Peer Agent yet",
    ]) {
      assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, excluded);
    }
  });

  it("uses delegate_task where the native Subagent tool falls short and once per review round", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "for same-provider work when the native Subagent tool cannot run the chosen model",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Do not treat a native tool's model list as the full list of available subagent models: use `orchestrator_capabilities`",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "For every delegated review round, call `delegate_task` again",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "prior findings");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Track each round by its own `taskId`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      'For a child task that needs a separate checkout, use `delegate_task` with `isolation:"worktree"` across any provider or model. It starts from the parent local commit and runs project setup; uncommitted edits are not copied.',
    );
  });

  it("documents structured schedules, webhooks included, instead of JSON strings", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, '{"type":"webhook"}');
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "report its `webhookUrl`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "set `bindToCurrentThread=false` only when the user wants a fresh thread for every run",
    );
  });

  it("carries upstream's secret, thread link, and visuals guidance", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "call `request_secret`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Never ask for a secret in chat");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "[title](t3-thread://v1/<threadId>)");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "### Showing visuals");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`html_preview`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`html_render`");
  });

  it("creates mixed crews from chat and keeps coordination independent of approvals and artifacts", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "A request to create, start, or assemble a crew must go through `j5_propose_crew` on the `t3-code` MCP server",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Never substitute provider-native Subagents, `delegate_task`, or individual `j5_spawn_agent` calls for a requested crew",
    );
    // Codex's own tool keeps its name: it is not J5's `j5_spawn_agent`.
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Codex's native `spawn_agent` or collaboration tools",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "report that blocker instead of launching replacement agents",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "asks for a crew in ordinary chat");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "saved personas from `j5_list_personas` with custom seats",
    );
    assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, "`list_agents`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Custom seats inherit your harness, model, and reasoning by default and run with full access",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`model_selection` (instanceId, model, options)");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`runtime_mode`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Saved personas use their own configuration");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "resolved provider, model, reasoning, and access",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Captains of other crews");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Do not wait for an artifact");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_request_crew_member`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "reason naming the concern and needed responsibility",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "while that request is pending");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "otherwise they queue for its next turn");
  });

  it("routes durable planning outputs into artifacts and excludes working files", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "durable, user-consumable planning outputs");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_write_artifact`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_list_artifacts`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_read_artifact`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "across threads and agents");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "source code, build output, logs");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "temporary scratch files");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Artifacts panel");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "outside the repository");
    // Handoffs are the one place j5_write_artifact appends instead of replacing; the model is told.
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Artifacts under `handoffs/` are versioned");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "rather than replacing it");
  });
});
