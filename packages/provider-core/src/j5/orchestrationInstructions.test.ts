import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "../server/orchestrationInstructions.ts";
import {
  J5_ACP_MCP_FALLBACK_INSTRUCTIONS,
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

  it("brand the ACP mode, browser, fallback, and orchestration guidance as J5 Code", () => {
    const prompt = "Inspect the repository.";
    const injected = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true },
    });
    assert.include(injected, "J5 Code interaction mode: Default");
    assert.include(injected, "## J5 Code browser");
    assert.include(injected, J5_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.include(injected, J5_ACP_MCP_FALLBACK_INSTRUCTIONS);
    assert.notInclude(injected, "T3 tools");
    assert.notInclude(injected, "T3 Code");
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { interactionMode: "plan", hasT3Mcp: false },
      }),
      "J5 Code interaction mode: Plan",
    );
  });

  it("carry upstream's subagent settings and model search rules", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "no settings beyond yours");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "for user-asked settings");
    assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, "inheritedOptions");
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
      "create_threads",
      "t3_thread_start",
      "t3_thread_send",
      "t3_thread_interrupt",
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
      "and it finishes in this turn (Claude `Agent` always with `run_in_background:false`; Codex `spawn_agent`, then wait)",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, 'a separate checkout (`isolation:"worktree"`)');
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "for background work");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Call `orchestrator_capabilities` once per thread, before the first `delegate_task`",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "A native tool's model list is not the full list.",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Never switch unasked");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Every new delegated review or re-check is a new `delegate_task`",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "prior findings");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Track each round by its own `taskId`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Fix small review findings yourself");
  });

  it("ends the turn on a running delegate and keeps children from delegating", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Follow a running delegate's `next`: its completion wakes this thread, so end your turn.",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Do not poll it (`task_status`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Stop a delegate run you replace or no longer need with `task_cancel`",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "If you are a subagent or delegated child, do the work yourself.",
    );
  });

  it("carries upstream's thread, secret, schedule, and visuals guidance", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`t3_thread_read` it before you answer about it");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "a thread's first mention is its `link` verbatim",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "[title](t3-thread://v1/<exact id>)");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "call `request_secret` yourself");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, '`delivery: "file"`');
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Never ask in chat or invent one");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "When asked only to schedule, `schedule_task` without running its prompt",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "### Visuals and preview");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "even unasked");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`html_preview`, then `html_render`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Never use `preview_*` to verify or show your own edit",
    );
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
