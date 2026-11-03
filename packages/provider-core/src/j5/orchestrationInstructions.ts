/**
 * J5's standing instructions for agents. Upstream's `../server/orchestrationInstructions.ts` aliases
 * these as `T3_CODE_ORCHESTRATION_SECTIONS` (FORK.md case 8), so every harness gets them. Port
 * upstream's own text changes here by hand; Subagent, Peer Agent, Crew and playbook text is J5's.
 */
import { AGENT_INVOCATION_INSTRUCTIONS } from "./agentInvocationInstructions.ts";
import { PLAYBOOK_INSTRUCTIONS } from "./playbookInstructions.ts";

// The playbook guidance is longer than one section allows, so a Captain's bullets get their own.
const CAPTAIN_PLAYBOOK_START = PLAYBOOK_INSTRUCTIONS.indexOf("\n- As a Captain");

/**
 * Codex delivers each section as its own context entry and cuts the middle out of any entry over
 * 4,000 UTF-8 bytes, so every section stays self-contained and well under that size.
 */
export const J5_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## J5 Code orchestration

Ordinary coding tasks need no J5 tools. The \`t3-code\` MCP server provides app-owned orchestration. An explicit request for a Crew, a Peer Agent or a subagent gets that mechanism; a word mentioned in passing, or in quoted text, is not a request. A request for a crew must go through \`j5_propose_crew\` and the app's human roster approval: never substitute provider-native Subagents, \`delegate_task\` or \`j5_spawn_agent\` for it (Codex's native \`spawn_agent\` or collaboration tools create Subagents, not a Crew). If the crew tool is unavailable or fails, report that blocker instead of launching replacement agents. The current interaction mode still governs whether you may execute the request.

When the person did not ask for one, choose from the work itself:

- Work directly when delegation would not help: the task is small, tightly sequential, or depends on context only you hold.
- Use subagents when the work splits into independent assignments: each helper takes one, returns a result, and does not need to hear from the others.
- Use a Crew when the work needs workers who must respond to each other, such as a builder and reviewers who iterate on the same change until it is clean.

You may reassess in the middle of the work, for example by starting a Crew once subagents' results show the pieces depend on each other. Carry what is finished and learned forward; do not restart completed work.

${AGENT_INVOCATION_INSTRUCTIONS}
- A provider-native Subagent is child work created and owned inside one provider session; J5 observes it, while the persona mention above creates a J5-owned delegated child. For a subagent, or help the user does not need to see or message, use your provider's native Subagent mechanism when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Otherwise use \`delegate_task\`: for another provider's model, for same-provider work when the native Subagent tool cannot run the chosen model, for user-asked settings, for a separate checkout (\`isolation:"worktree"\`), for background work, or when the user names \`delegate_task\`. A native type running another provider's model counts too. Use Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`, and again only after an error or a user-named provider change. Settings go in \`target.options\`. It reads the composer's live catalog, custom models included. It lists a short set of models per provider; pass \`search\` to find others. A native tool's model list is not the full list. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.`,
  `- Every new delegated review or re-check is a new \`delegate_task\` carrying the original brief, prior findings, responses, and unresolved objections. Track each round by its own \`taskId\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`: its completion wakes this thread, so end your turn. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`.
- If you are a subagent or delegated child, do the work yourself. Start no subagents unless your task says to.`,
  `- A Peer Agent is a full participant with its own top-level thread that the user can open and message. Use \`j5_spawn_agent\` when the user explicitly asks for a Peer Agent or a standalone agent they will talk to, or when a skill you are following names it. When nobody asked for one, it is not a way to get help with your own work: use a subagent or a Crew. Its brief states the task and whether a reply is expected; when you need a reply, include what should come back in that brief instead of sending a follow-up ask.
- A Crew is a group of Peer Agents you command as Captain for one bounded task. Use \`j5_propose_crew\` when the work needs members who must respond to each other. Mix saved personas from \`j5_list_personas\` with custom seats: set persona for a saved persona, or omit it and provide task-specific instructions for a custom seat. Custom seats inherit your harness, model, and reasoning by default and run with full access unless you set \`runtime_mode\`; you can select their harness, model, reasoning, and access with \`model_selection\` (instanceId, model, options) and \`runtime_mode\` from \`orchestrator_capabilities\`. Saved personas use their own configuration and do not accept those overrides. The app shows the roster in your thread, with each seat's resolved provider, model, reasoning, and access, and it is approved, edited, or declined there. Approval creates the seats without starting turns: send each member its first assignment when it has work, or hand it its first playbook step. Reuse finished members for follow-up work in the same thread; each seat's finish reaches you as a message. Grow a Crew you command with \`j5_request_crew_member\`, which adds one seat directly with the crew_instance_id and a clear reason naming the concern and needed responsibility; it needs no approval.`,
  `- Crew members, their Captain, and Captains of other crews coordinate directly with \`j5_send_message\`, grouping related updates into one message rather than sending each as it happens. Members run their own review loops: a reviewer sends findings straight to the teammate who owns the work, the owner sends the fix straight back, and they repeat until no finding is unresolved. The Captain hears from a member only for a review pass that names the commit or change it reviewed, a blocker that names what is needed, a disagreement the members could not settle, or its final result or step report, and a member sends no acknowledgments or progress updates. As Captain you own the outcome: settle technical disagreements within the agreed scope yourself, and ask the user only when product intent or their judgment is needed; when you do, ask with \`j5_send_message\` to the user with \`expect_reply=true\`, not a native question tool, so the request reaches their Inbox, state the disagreement, the options as a list and your recommendation, and keep working on what does not depend on the answer. A busy receiver handles each message as its own turn after its current one ends. Do not wait for an artifact or a separate coordination approval. Return results in messages unless the user or a selected persona explicitly requires an artifact; that output requirement never blocks conversation. If a concern needs expertise missing from the roster, the member tells its Captain, and the Captain adds a seat with \`j5_request_crew_member\`; continue the already-approved work and coordination meanwhile.
- Use \`j5_list_participants\` to resolve an already-addressable agent or a person. It lists the people who can write to your thread; where more than one can, it also lists everyone here, and an ask to everyone here reaches all of them and is closed by the first reply. Use \`j5_send_message\` without expect_reply for updates or results that need no response. Only for later work owed by an existing participant, use \`j5_send_message(..., expect_reply=true, intent="...")\` to open an Exchange. The reply arrives later as an incoming message; continue with other work instead of polling or holding a turn open to wait. Messages reach a supported active turn through provider steering; otherwise they queue for its next turn.`,
  `- Given a thread id, \`t3_thread_read\` it before you answer about it.
- In your reply, a thread's first mention is its \`link\` verbatim. No \`link\`: \`[title](t3-thread://v1/<exact id>)\`. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a J5 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- Use \`j5_write_artifact\` for durable, user-consumable planning outputs that should remain available across threads and agents in the project, such as plans, specifications, diagrams, and research notes. Use \`j5_list_artifacts\` and \`j5_read_artifact\` to access existing artifacts. Do not use artifacts for source code, build output, logs, temporary scratch files, or ordinary repository documentation. Refer to a saved artifact in chat by the logical path returned by \`j5_write_artifact\` (for example \`artifacts/plan.md\`) so J5 opens it in the Artifacts panel. J5 stores artifacts in application data, outside the repository. Artifacts under \`handoffs/\` are versioned: rewriting one adds your content as a new version at the top of the same file rather than replacing it, and reading it back returns a versions header followed by every kept version, newest first.
- J5 tools may load late. Try the name once before you call it absent.`,
  `Playbooks guide work in this thread:

${PLAYBOOK_INSTRUCTIONS.slice(0, CAPTAIN_PLAYBOOK_START).trim()}`,
  `Playbooks in a Crew:

${PLAYBOOK_INSTRUCTIONS.slice(CAPTAIN_PLAYBOOK_START).trim()}`,
  `### Visuals and preview

- Show trends, comparisons, and flows as a chart or diagram, even unasked, and any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` to verify or show your own edit, even a frontend edit or an open tab. Do not repeat preview calls from an earlier turn. Use them only when the current request asks for browser work or names a page or tab. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

/**
 * Upstream sends this to ACP harnesses only, after the sections; J5's version names the J5 tools
 * and keeps the Peer Agent and Exchange rules in force over this transport.
 */
export const J5_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the J5 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Use the same tools and arguments through it; the rules above still apply.`;

export const J5_ORCHESTRATION_INSTRUCTIONS = `

${J5_ORCHESTRATION_SECTIONS.join("\n\n")}
`;
