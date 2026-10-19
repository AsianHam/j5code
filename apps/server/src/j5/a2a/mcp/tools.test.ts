import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { A2A_SEND_TOOL_DESCRIPTION } from "../EnvelopeFormatter.ts";
import { J5OrchestratorSurface } from "./orchestratorSurface.ts";
import { J5_CLAUDE_MCP_ALLOWED_TOOLS } from "./claudeAllowedTools.ts";
import {
  J5ArchiveCrewTool,
  J5ProposeCrewTool,
  J5ProposeCrewInput,
  J5RequestCrewMemberTool,
  J5RequestCrewMemberInput,
  J5SendMessageTool,
  J5SpawnAgentTool,
  J5StopAgentTool,
  J5Toolkit,
  J5_PROPOSE_CREW_DESCRIPTION,
  J5_SPAWN_AGENT_DESCRIPTION,
  J5_STOP_AGENT_DESCRIPTION,
} from "./tools.ts";

const decodeProposeCrew = Schema.decodeUnknownSync(J5ProposeCrewInput);
const decodeRequestCrewMember = Schema.decodeUnknownSync(J5RequestCrewMemberInput);

it("publishes the ratified single-target lifecycle contracts fail-closed", () => {
  assert.equal(J5SendMessageTool.description, A2A_SEND_TOOL_DESCRIPTION);
  assert.include(
    J5SendMessageTool.description ?? "",
    "To the human, only an ask: a plain send to a person is refused",
  );
  assert.equal(J5SpawnAgentTool.description, J5_SPAWN_AGENT_DESCRIPTION);
  assert.equal(J5StopAgentTool.description, J5_STOP_AGENT_DESCRIPTION);
  const sp4BriefSteering =
    "In your brief, tell the new agent what it should do first and whether it should reply to you.";
  assert.equal(J5SpawnAgentTool.description?.split(sp4BriefSteering).length, 2);
  assert.notInclude(J5SpawnAgentTool.description ?? "", "j5_send_message");
  assert.notInclude(J5SpawnAgentTool.description ?? "", "expect_reply");

  const spawnSchema = Tool.getJsonSchema(J5SpawnAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const stopSchema = Tool.getJsonSchema(J5StopAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.sameMembers(
    [...(spawnSchema.required ?? [])],
    ["brief", "provider", "model", "reasoning", "workspace"],
  );
  assert.sameMembers([...(stopSchema.required ?? [])], ["participant_id"]);
  assert.property(spawnSchema.properties ?? {}, "client_request_id");
  assert.property(spawnSchema.properties ?? {}, "persona");
  // No pre-dogfood compatibility spelling: `persona` is the only name the model sees.
  assert.notProperty(spawnSchema.properties ?? {}, "agent");
  assert.include(J5SpawnAgentTool.description ?? "", "one of that persona's declared routes");
  assert.property(stopSchema.properties ?? {}, "client_request_id");
  assert.sameMembers(Object.keys(J5Toolkit.tools), [
    "j5_playbook_back",
    "j5_playbook_cancel",
    "j5_playbook_complete",
    "j5_playbook_current",
    "j5_playbook_list",
    "j5_playbook_next",
    "j5_playbook_read",
    "j5_playbook_reselect",
    "j5_playbook_save",
    "j5_playbook_start",
    "j5_send_message",
    "j5_list_personas",
    "j5_list_participants",
    "j5_propose_crew",
    "j5_request_crew_member",
    "j5_spawn_agent",
    "j5_stop_agent",
    "j5_stop_crew",
    "j5_archive_crew",
    "j5_clear_own_ask",
  ]);
  assert.include(J5ArchiveCrewTool.description ?? "", "only as a unit");
  assert.include(J5ArchiveCrewTool.description ?? "", "confirmation_token");
  assert.include(J5ArchiveCrewTool.description ?? "", "check with the user");
  assert.isTrue(Context.get(J5ArchiveCrewTool.annotations, Tool.Destructive));
  // Proposals only file a human-gated request, and must say so: read-only Captains run with
  // approval policy never and have refused the brief when the gate looked like a shell approval.
  assert.isFalse(Context.get(J5ProposeCrewTool.annotations, Tool.Destructive));
  assert.isFalse(Context.get(J5RequestCrewMemberTool.annotations, Tool.Destructive));
  assert.include(J5ProposeCrewTool.description ?? "", "including approval policy never");
  assert.include(J5RequestCrewMemberTool.description ?? "", "including approval policy never");
  // Declared handoffs are written by the seat itself with the project j5_write_artifact tool
  // (artifacts live in application storage, not the sandboxed workspace), so a read-only Claude
  // persona must have it pre-approved beside the J5 verbs. The artifact reads are upstream's.
  assert.sameMembers(
    [...J5_CLAUDE_MCP_ALLOWED_TOOLS],
    [
      ...Object.keys(J5Toolkit.tools).map((name) => `mcp__t3-code__${name}`),
      "mcp__t3-code__j5_write_artifact",
      "mcp__t3-code__delegate_task",
      "mcp__t3-code__task_status",
      "mcp__t3-code__task_cancel",
    ],
  );
  assert.isFalse(Context.get(J5SpawnAgentTool.annotations, Tool.Idempotent));
  assert.isFalse(Context.get(J5StopAgentTool.annotations, Tool.Idempotent));
});

// Claude Code drops EVERY tool of an MCP server when one tool's input schema has no top-level
// `type: "object"` (verified 2026-09-10 with a probe server: a single top-level `anyOf` tool made
// the whole server's inventory vanish while it still reported "connected"). `Schema.Struct({})`
// encodes as exactly that anyOf, which is how `j5_list_personas` silently took the whole t3-code
// toolkit away from every Claude thread. No-input tools must omit `parameters` instead.
it("publishes every tool with a top-level object input schema", () => {
  for (const tool of [
    ...Object.values(J5Toolkit.tools),
    ...Object.values(J5OrchestratorSurface.tools),
  ]) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
    };
    assert.equal(schema.type, "object", `${tool.name} must publish type: "object"`);
    assert.isUndefined(schema.anyOf, `${tool.name} must not publish a top-level anyOf`);
  }
});

it("accepts explicit custom seat settings through both crew tools without requiring a persona", () => {
  const custom = {
    workspace: { type: "shared" as const },
    seat: "reviewer",
    reason: "Review correctness",
    instructions: "Report findings and evidence.",
    model_selection: {
      instanceId: ProviderInstanceId.make("codex-custom"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtime_mode: "approval-required",
  } satisfies J5RequestCrewMemberInput;
  const roster = { name: "Review", brief: "Review the change.", seats: [custom] };
  assert.deepStrictEqual(decodeProposeCrew(roster), roster);
  assert.deepStrictEqual(decodeRequestCrewMember(custom), custom);
  assert.throws(() =>
    decodeRequestCrewMember({
      ...custom,
      runtime_mode: "invented-access-mode",
    }),
  );
  assert.throws(() =>
    decodeRequestCrewMember({
      ...custom,
      model_selection: { model: "gpt-6-astra" },
    }),
  );
  // The published tool must expose canonical, typed fields rather than the legacy decoder's
  // unknown-valued source fields, so providers can actually choose a valid configuration.
  const schema = Tool.getJsonSchema(J5RequestCrewMemberTool) as {
    properties: Record<string, { anyOf?: ReadonlyArray<{ type?: string; required?: string[] }> }>;
  };
  const selection = schema.properties.model_selection?.anyOf?.find(
    (entry) => entry.type === "object",
  );
  assert.isDefined(selection);
  assert.sameMembers(selection?.required ?? [], ["instanceId", "model"]);
  assert.property(schema.properties, "runtime_mode");
});

it("tells a Captain proposing a crew how a playbook shapes the roster", () => {
  assert.include(J5_PROPOSE_CREW_DESCRIPTION, "For a crew built from a playbook");
});
