import type { RuntimeMode } from "@t3tools/contracts";

/** The policy fields every adapter can supply, including ACP's `AcpRuntimePolicy`. */
export interface J5RuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
}

/** Definition writes have their own server-side policy check, unlike progress-only tools. */
export const J5_DEFINITION_WRITE_TOOLS: ReadonlyArray<string> = ["j5_playbook_save"];

/**
 * The t3-code tools Codex and Claude pre-approve, so the roster gate stays the only human step.
 * Harnesses prompt for MCP tools not annotated read-only, and approval policy `never` (full access,
 * every saved-agent policy) rejects them. Pre-approved: the J5 verbs, whose handlers authorize each
 * call, `j5_write_artifact` for handoffs, and the Subagent verbs Crew members use.
 */
export const J5_PREAPPROVED_TOOLS: ReadonlyArray<string> = [
  ...J5_DEFINITION_WRITE_TOOLS,
  "j5_send_message",
  "j5_list_participants",
  "j5_spawn_agent",
  "j5_list_personas",
  "j5_propose_crew",
  "j5_request_crew_member",
  // Declared handoffs are files the seat writes itself into application storage.
  "j5_write_artifact",
  // Provider-native Subagents: the one way a Crew member gets more hands.
  "delegate_task",
  "task_status",
  "task_cancel",
  "j5_stop_agent",
  "j5_stop_crew",
  "j5_archive_crew",
  "j5_clear_own_ask",
  "j5_playbook_list",
  "j5_playbook_read",
  "j5_playbook_start",
  "j5_playbook_current",
  "j5_playbook_next",
  "j5_playbook_back",
  "j5_playbook_reselect",
  "j5_playbook_complete",
  "j5_playbook_cancel",
];

/**
 * Interactive modes pre-approve routine communication, owner-thread playbook progress, and filing
 * roster requests; the latter still require human approval in the app before any member launches.
 * Lifecycle and spawning tools keep the harness's prompting in those modes.
 */
export const J5_COORDINATION_TOOLS: ReadonlyArray<string> = [
  "j5_send_message",
  "j5_clear_own_ask",
  "j5_propose_crew",
  "j5_request_crew_member",
  "j5_playbook_start",
  "j5_playbook_next",
  "j5_playbook_back",
  "j5_playbook_reselect",
  "j5_playbook_complete",
  "j5_playbook_cancel",
];

/** Mirrors the adapters' runtime-mode default: only full-access resolves to `never` on its own. */
export const j5ApprovalPolicyIsNever = (runtimePolicy: J5RuntimePolicy | undefined): boolean =>
  runtimePolicy !== undefined &&
  (runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "full-access"
    : runtimePolicy.approvalPolicy === "never");

/** The bare t3-code tool names a harness should pre-approve for this runtime policy. */
export const j5PreapprovedTools = (
  runtimePolicy: J5RuntimePolicy | undefined,
): ReadonlyArray<string> =>
  j5ApprovalPolicyIsNever(runtimePolicy) ? J5_PREAPPROVED_TOOLS : J5_COORDINATION_TOOLS;

/** The `mcp__<server>__<tool>` name Claude-style harnesses match against. */
export const j5T3McpToolName = (name: string): string => `mcp__t3-code__${name}`;
