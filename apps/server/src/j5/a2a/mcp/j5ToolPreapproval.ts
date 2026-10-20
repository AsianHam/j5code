import type { RuntimeMode } from "@t3tools/contracts";

/** The policy fields every adapter can supply, including ACP's `AcpRuntimePolicy`. */
export interface J5RuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
}

/** Definition writes have their own server-side policy check, unlike progress-only tools. */
export const J5_DEFINITION_WRITE_TOOLS: ReadonlyArray<string> = ["j5_playbook_save"];

/**
 * The t3-code tools Codex and Claude pre-approve so the roster gate stays the only human step there.
 * Harnesses gate every MCP tool that is not annotated read-only behind an approval prompt, and a
 * turn whose approval policy is `never` (Codex 0.153+: "MCP tool call requires approval, but
 * approval policy is never") rejects the call outright. Full-access mode and every saved-agent
 * runtime policy send exactly that, so without help `j5_send_message`, `j5_spawn_agent`, and
 * `j5_propose_crew` all fail there. Only the J5 verbs are pre-approved, by name: their handlers
 * authorize each call and their real gates live server-side, plus `j5_write_artifact`, which a saved
 * agent needs for its declared handoff file (application storage, never the workspace), plus the
 * provider-native Subagent verbs (`delegate_task`, `task_status`, `task_cancel`): a Crew member is
 * refused `j5_spawn_agent` and told to run its own helpers as Subagents, so those must work under
 * the same policy, and a child inherits its parent's sandbox through the escalation check. The
 * rest of the t3-code server (worktree handoff, browser preview, scheduling) keeps the harness's
 * own verdict, so a read-only persona under `never` still cannot reach those. Kept as a leaf
 * module (no toolkit import) so adapters avoid a cycle; the test checks the list against
 * J5Toolkit.
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
