import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { A2A_SEND_TOOL_DESCRIPTION } from "../../../j5/a2a/EnvelopeFormatter.ts";
import { A2ALedger } from "../../../j5/a2a/LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "../../../j5/a2a/PeerDirectory.ts";
import { ParticipantPlacementService } from "../../../j5/a2a/PlacementService.ts";
import { A2ASendService } from "../../../j5/a2a/SendService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      }),
  }),
  Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([]) }),
  Layer.mock(ParticipantPlacementService)({ listParticipants: () => Effect.succeed([]) }),
  Layer.mock(A2ALedger)({ listProjectLedgers: () => Effect.succeed([]) }),
  peerDirectoryNoneLayer,
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeRpcFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Number, message: Schema.String }) }),
);

const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);
const decodeToolCallPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.optional(Schema.Boolean),
        content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      }),
    }),
  ),
);

it.effect("production mcp layer lists worktree tools over http", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(layerRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-scratch" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(layerStubServices),
        Layer.build,
      );

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const httpClient = yield* HttpClient.HttpClient;
      const unauthorizedResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"unauthorized","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(unauthorizedResponse.status).toBe(401);
      const foreignRegistry = yield* McpSessionRegistry.__testing.make({ now: () => 1 }).pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-other")),
          getDescriptor: Effect.die("unused foreign environment descriptor"),
        }),
      );
      const foreignCredential = yield* foreignRegistry.issue({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const wrongEnvironmentResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: foreignCredential.config.authorizationHeader,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"j5_list_participants","arguments":{}}}`,
          "application/json",
        ),
      });
      expect(wrongEnvironmentResponse.status).toBe(401);

      const auth = credential!.config.authorizationHeader;
      const initResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers["mcp-session-id"];

      const listResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      const bodyText = yield* listResponse.text;
      const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
      const tools = payload.result.tools;
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("t3_worktree_handoff");
      expect(toolNames).toContain("t3_worktree_status");
      // The worktree registration merges alongside the other toolkits rather
      // than replacing them.
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("orchestrator_capabilities");
      expect(toolNames).toContain("schedule_task");
      expect(toolNames).toContain("t3_thread_list");
      expect(toolNames).toContain("t3_thread_read");
      // Blocking on another thread starves a participant of the notices it waits for.
      expect(toolNames).not.toContain("t3_thread_wait");
      // J5 re-declares delegate_task with a saved-agent parameter and keeps its status/cancel pair.
      expect(toolNames).toContain("delegate_task");
      expect(toolNames).toContain("task_status");
      expect(toolNames).toContain("task_cancel");
      for (const excluded of [
        "t3_thread_launch",
        "t3_project_delete",
        "t3_queue_edit",
        "t3_queue_cancel",
        "t3_queue_reorder",
        "t3_queue_promote_to_steer",
        "create_threads",
        "t3_thread_start",
        "t3_thread_send",
        // An agent attaches files with j5_send_message.
        "t3_thread_send_attachments",
        "t3_thread_interrupt",
      ]) {
        expect(toolNames).not.toContain(excluded);
      }
      // J5 uses the same authenticated transport and one shared registration
      // that later J5 milestones extend inside the fork-owned toolkit.
      expect(toolNames).toContain("j5_send_message");
      expect(toolNames).toContain("j5_list_participants");
      expect(tools.find((tool) => tool.name === "j5_send_message")?.description).toBe(
        A2A_SEND_TOOL_DESCRIPTION,
      );
      expect(toolNames.toSorted()).toEqual([
        "delegate_task",
        "delete_scheduled_task",
        "device_close",
        "device_list",
        "device_open",
        "device_screenshot",
        "html_preview",
        "html_render",
        "j5_archive_crew",
        "j5_clear_own_ask",
        "j5_list_artifacts",
        "j5_list_participants",
        "j5_list_personas",
        "j5_playbook_back",
        "j5_playbook_cancel",
        "j5_playbook_complete",
        "j5_playbook_current",
        "j5_playbook_list",
        "j5_playbook_next",
        "j5_playbook_read",
        "j5_playbook_reselect",
        "j5_playbook_start",
        "j5_propose_crew",
        "j5_read_artifact",
        "j5_request_crew_member",
        "j5_send_message",
        "j5_spawn_agent",
        "j5_stop_agent",
        "j5_stop_crew",
        "j5_write_artifact",
        "link_pull_request",
        "list_scheduled_tasks",
        "list_thread_pull_requests",
        "orchestrator_capabilities",
        "preview_click",
        "preview_dialog",
        "preview_drag",
        "preview_evaluate",
        "preview_hover",
        "preview_navigate",
        "preview_open",
        "preview_press",
        "preview_recording_start",
        "preview_recording_stop",
        "preview_resize",
        "preview_scroll",
        "preview_select",
        "preview_set_appearance",
        "preview_snapshot",
        "preview_status",
        "preview_type",
        "preview_upload",
        "preview_wait_for",
        "request_secret",
        "run_scheduled_task_now",
        "schedule_task",
        "t3_attachment_discard",
        "t3_attachment_prepare_upload",
        "t3_environment_preferences_update",
        "t3_environment_read",
        "t3_pending_request_list",
        "t3_pending_request_read",
        "t3_pending_request_respond",
        "t3_preview_close",
        "t3_preview_list",
        "t3_project_clone",
        "t3_project_create",
        "t3_project_list",
        "t3_project_read",
        "t3_project_update",
        "t3_queue_list",
        "t3_queue_read",
        "t3_thread_configuration",
        "t3_thread_configure",
        "t3_thread_fork",
        "t3_thread_list",
        "t3_thread_merge_back",
        "t3_thread_organize",
        "t3_thread_read",
        "t3_thread_search",
        "t3_thread_transfers",
        "t3_thread_update",
        "t3_worktree_handoff",
        "t3_worktree_list",
        "t3_worktree_status",
        "task_cancel",
        "task_status",
        "unlink_pull_request",
        "unwatch_pull_request",
        "update_scheduled_task",
        "watch_pull_request",
      ]);

      const restricted = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-without-browser"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        browserToolsAvailable: false,
      });
      expect(restricted).toBeDefined();
      const restrictedInit = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: restricted!.config.authorizationHeader,
        },
        body: HttpBody.text(
          encodeJson({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "restricted", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      expect(restrictedInit.status).toBe(200);
      const restrictedSessionId = restrictedInit.headers["mcp-session-id"];
      const callRestricted = Effect.fn(function* (id: number, name: string) {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: restricted!.config.authorizationHeader,
            "mcp-protocol-version": "2025-06-18",
            ...(restrictedSessionId ? { "mcp-session-id": restrictedSessionId } : {}),
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: {} },
            }),
            "application/json",
          ),
        });
        expect(response.status).toBe(200);
        const text = yield* response.text;
        return yield* decodeToolCallPayload(text.match(/\{.*\}/s)![0]);
      });
      for (const [index, name] of [
        "t3_thread_launch",
        "t3_project_delete",
        "t3_queue_edit",
        "t3_queue_cancel",
        "t3_queue_reorder",
        "t3_queue_promote_to_steer",
      ].entries()) {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: restricted!.config.authorizationHeader,
            "mcp-protocol-version": "2025-06-18",
            ...(restrictedSessionId ? { "mcp-session-id": restrictedSessionId } : {}),
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 100 + index,
              method: "tools/call",
              params: { name, arguments: {} },
            }),
            "application/json",
          ),
        });
        const responseText = yield* response.text;
        const refused = yield* decodeRpcFailure(decodeJson(responseText.match(/\{.*\}/s)![0]));
        expect(refused.error.code).toBe(-32602);
        expect(refused.error.message).toContain(name);
      }
      // J5's tools were renamed with a `j5_` prefix and kept no aliases. An agent resumed from
      // before the rename may still call an old name; it gets the unknown-tool error by name.
      const j5ToolNames = toolNames.filter((name) => name.startsWith("j5_"));
      expect(j5ToolNames).toHaveLength(22);
      for (const [index, name] of j5ToolNames.map((name) => name.slice("j5_".length)).entries()) {
        expect(toolNames).not.toContain(name);
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: restricted!.config.authorizationHeader,
            "mcp-protocol-version": "2025-06-18",
            ...(restrictedSessionId ? { "mcp-session-id": restrictedSessionId } : {}),
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 200 + index,
              method: "tools/call",
              params: { name, arguments: {} },
            }),
            "application/json",
          ),
        });
        const responseText = yield* response.text;
        const refused = yield* decodeRpcFailure(decodeJson(responseText.match(/\{.*\}/s)![0]));
        expect(refused.error.code).toBe(-32602);
        expect(refused.error.message).toBe(`Tool '${name}' not found`);
      }
      const deniedPreview = yield* callRestricted(3, "preview_status");
      expect(deniedPreview.result.isError).toBe(true);
      expect(deniedPreview.result.content[0]?.text).toContain("preview");
      const allowedDirectory = yield* callRestricted(4, "j5_list_participants");
      expect(allowedDirectory.result.isError).not.toBe(true);
      expect(decodeJson(allowedDirectory.result.content[0]!.text)).toEqual({
        participants: [],
        next_cursor: null,
        total: 0,
        unread_peer_count: 0,
      });

      // The handoff tool mutates thread state, reaches the network (origin
      // fetch), and runs project setup scripts, so its MCP hints must not
      // promise a read-only, closed-world, non-destructive tool.
      const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "t3_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "j5-mcp-registration-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
);
