import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { J5DelegateTaskTool } from "../../agents/agentDelegation.ts";
import { A2A_SEND_TOOL_DESCRIPTION } from "../EnvelopeFormatter.ts";
import { J5AttachmentUploadToolkit } from "./attachments.ts";
import { J5AdaptedThreadToolkit } from "./threadTools.ts";
import {
  J5ArtifactToolkit,
  J5EnvironmentToolkit,
  J5ProjectToolkit,
  J5OrchestratorToolkit,
  J5ThreadToolkit,
} from "./upstreamCatalog.ts";
import { J5OrchestratorSurface } from "./orchestratorSurface.ts";
import { J5_CLAUDE_MCP_ALLOWED_TOOLS } from "./claudeAllowedTools.ts";
import {
  J5ArchiveCrewTool,
  J5ProposeCrewTool,
  J5ProposeCrewInput,
  J5RequestCrewMemberTool,
  J5RequestCrewMemberInput,
  J5SendMessageTool,
  J5SpawnAgentInput,
  J5SpawnAgentTool,
  J5StopAgentTool,
  J5Toolkit,
  J5_PROPOSE_CREW_DESCRIPTION,
  J5_REQUEST_CREW_MEMBER_DESCRIPTION,
  J5_SPAWN_AGENT_DESCRIPTION,
  J5_STOP_AGENT_DESCRIPTION,
} from "./tools.ts";

const decodeProposeCrew = Schema.decodeUnknownSync(J5ProposeCrewInput);
const decodeRequestCrewMember = Schema.decodeUnknownSync(J5RequestCrewMemberInput);
const decodeSpawnAgent = Schema.decodeUnknownSync(J5SpawnAgentInput);

it.effect.each([
  { name: "j5_spawn_agent", description: J5_SPAWN_AGENT_DESCRIPTION, tool: J5SpawnAgentTool },
  { name: "j5_propose_crew", description: J5_PROPOSE_CREW_DESCRIPTION, tool: J5ProposeCrewTool },
  {
    name: "j5_request_crew_member",
    description: J5_REQUEST_CREW_MEMBER_DESCRIPTION,
    tool: J5RequestCrewMemberTool,
  },
])("publishes the canonical $name description byte-for-byte", ({ name, description, tool }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const document = yield* fileSystem.readFileString(
      decodeURIComponent(
        new URL("../../../../../../docs/j5/product/a2a/agent-tools.md", import.meta.url).pathname,
      ),
    );
    const section = document.split("### `" + name + "`")[1]?.split("\n### ")[0];
    const quoted = section?.match(/\*\*Description \(contract\):\*\* "([\s\S]*?)"\n\n/)?.[1];
    if (quoted === undefined)
      return yield* Effect.die(`${name} contract description is missing from agent-tools.md`);
    const documented = quoted
      .split("\n")
      .map((line) => line.trim())
      .join(" ");
    assert.equal(description, documented);
    assert.equal(tool.description, documented);
  }).pipe(Effect.provide(NodeServices.layer)),
);

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
    ["brief", "title", "provider", "model", "reasoning", "workspace"],
  );
  assert.sameMembers([...(stopSchema.required ?? [])], ["participant_id"]);
  assert.property(spawnSchema.properties ?? {}, "client_request_id");
  assert.property(spawnSchema.properties ?? {}, "persona");
  // No pre-dogfood compatibility spelling: `persona` is the only name the model sees.
  assert.notProperty(spawnSchema.properties ?? {}, "agent");
  assert.include(J5SpawnAgentTool.description ?? "", "one of that persona's declared routes");
  assert.property(stopSchema.properties ?? {}, "client_request_id");
  // Exact on purpose: no tool answers the Inbox's worktree cleanup approval; only a person can.
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
  assert.isTrue(Context.get(J5ProposeCrewTool.annotations, Tool.Destructive));
  assert.isTrue(Context.get(J5RequestCrewMemberTool.annotations, Tool.Destructive));
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

// These are provider-facing safety hints, independent of J5's pre-approval list. This
// checks the advertised contract; actual Codex policy acceptance needs a live provider run.
it("publishes closed-world, non-destructive hints for every read-only J5 tool", () => {
  const tools = [
    ...Object.values(J5Toolkit.tools),
    ...Object.values(J5ArtifactToolkit.tools),
    ...Object.values(J5OrchestratorSurface.tools),
    ...Object.values(J5EnvironmentToolkit.tools),
    ...Object.values(J5ProjectToolkit.tools),
    ...Object.values(J5OrchestratorToolkit.tools),
    ...Object.values(J5ThreadToolkit.tools),
    ...Object.values(J5AdaptedThreadToolkit.tools),
    ...Object.values(J5AttachmentUploadToolkit.tools),
  ];
  const reads = tools.filter((tool) => Context.get(tool.annotations, Tool.Readonly));
  assert.includeMembers(
    reads.map((tool) => tool.name),
    [
      "j5_playbook_list",
      "j5_playbook_read",
      "j5_playbook_current",
      "orchestrator_capabilities",
      "t3_environment_read",
      "t3_project_read",
      "t3_thread_search",
      "j5_list_personas",
      "j5_list_participants",
    ],
  );
  for (const tool of reads) {
    assert.isFalse(Context.get(tool.annotations, Tool.Destructive), tool.name);
    assert.isFalse(Context.get(tool.annotations, Tool.OpenWorld), tool.name);
  }
  for (const tool of [
    J5OrchestratorToolkit.tools.t3_thread_read,
    J5OrchestratorToolkit.tools.task_status,
  ]) {
    assert.isFalse(Context.get(tool.annotations, Tool.Readonly), tool.name);
  }
});

// Claude Code drops EVERY tool of an MCP server when one tool's input schema lacks a top-level
// `type: "object"` (verified 2026-09-10), while still reporting "connected". `Schema.Struct({})`
// encodes as a top-level anyOf, so no-input tools must omit `parameters`.
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

it("refuses a blank spawn title and stores it trimmed", () => {
  const spawn = {
    brief: "Fix the flaky login test and report back.",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "high",
    workspace: { type: "shared" },
  };
  assert.throws(() => decodeSpawnAgent({ ...spawn, title: "   " }));
  assert.equal(decodeSpawnAgent({ ...spawn, title: " Login fixer " }).title, "Login fixer");
});

it("says which of the two ways to get help each tool serves", () => {
  // j5_spawn_agent serves neither: it is for a Peer Agent the user asked for.
  assert.include(J5_SPAWN_AGENT_DESCRIPTION, "explicitly asks for a Peer Agent");
  assert.include(
    J5_SPAWN_AGENT_DESCRIPTION,
    "When nobody asked for one, it is not a way to get help with your own work",
  );
  assert.include(J5_SPAWN_AGENT_DESCRIPTION, "create a subagent");
  assert.include(J5_PROPOSE_CREW_DESCRIPTION, "the second of the two ways to get help");
  assert.include(J5_PROPOSE_CREW_DESCRIPTION, "Use it when the user asks for a crew");
  assert.notInclude(J5_PROPOSE_CREW_DESCRIPTION, "does not decide it");
  assert.include(J5_REQUEST_CREW_MEMBER_DESCRIPTION, "the second of the two ways to get help");
  assert.include(J5DelegateTaskTool.description, "the first of the two ways to get help");
});

it("tells a Captain proposing a crew how a playbook shapes the roster", () => {
  assert.include(J5_PROPOSE_CREW_DESCRIPTION, "For a crew built from a playbook");
});
