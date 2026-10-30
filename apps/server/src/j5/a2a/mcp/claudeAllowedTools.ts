import { J5_PREAPPROVED_TOOLS, j5T3McpToolName } from "./j5ToolPreapproval.ts";

/**
 * Tools Claude pre-approves in a read-only sandbox: the shared J5 set (j5ToolPreapproval.ts).
 * Read-only personas run in `dontAsk` mode, which silently denies anything not allowed, so without
 * this a read-only Captain could not message or propose. The handlers enforce persona permissions;
 * the sandbox guards the workspace. tools.test.ts checks this list.
 */
export const J5_CLAUDE_MCP_ALLOWED_TOOLS: ReadonlyArray<string> =
  J5_PREAPPROVED_TOOLS.map(j5T3McpToolName);
