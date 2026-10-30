import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import packageJson from "../../../package.json" with { type: "json" };
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeReplayServerConfig } from "../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { CREW_SEAT_QUESTION_INSTRUCTIONS, J5_CODEX_CREW_SEAT_CONFIG } from "./crewSeatQuestions.ts";
import { withCrewSeatQuestions } from "./crewSeatRuntime.ts";

const { buildCodexTurnStartParams } = CodexAdapterV2;
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

const basePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const seatPolicy = withCrewSeatQuestions(basePolicy);

/**
 * Opens a Codex session and its thread through the adapter, returning the `thread/start` config
 * it sent. The replay also refuses any config key it does not expect, MCP servers aside.
 */
const threadStartConfig = (
  scenario: string,
  runtimePolicy: typeof basePolicy,
  expectedConfig: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread-${scenario}`);
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: EnvironmentId.make("environment-codex-crew-seat"),
      threadId,
      providerSessionId: `mcp-session-${scenario}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    });
    const transcript: CodexReplay.CodexAppServerReplayTranscript = {
      provider: "codex",
      protocol: "codex.app-server",
      version: "0.144.0",
      scenario,
      entries: [
        {
          type: "expect_outbound",
          frame: {
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
              capabilities: {
                experimentalApi: true,
                optOutNotificationMethods: ["turn/diff/updated"],
                extensions: {
                  "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
                },
              },
            },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            id: 1,
            result: {
              userAgent: "T3 Code/0.156.1",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "linux",
            },
          },
        },
        { type: "expect_outbound", frame: { method: "initialized" } },
        {
          type: "expect_outbound",
          frame: { id: 2, method: "thread/start", params: { config: expectedConfig } },
        },
        {
          type: "emit_inbound",
          frame: {
            id: 2,
            result: {
              thread: {
                id: `native-${scenario}`,
                sessionId: `native-${scenario}`,
                forkedFromId: null,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1782622440,
                updatedAt: 1782622440,
                status: { type: "idle" },
                path: `/tmp/native-${scenario}.jsonl`,
                cwd: "/workspace",
                cliVersion: "0.144.0",
                source: "vscode",
                threadSource: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
              },
              model: "gpt-5.6-sol",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/workspace",
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              reasoningEffort: "medium",
            },
          },
        },
      ],
    };
    const sent: Array<unknown> = [];
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory: {
        open: () =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
            ),
            Effect.map(
              (client) =>
                ({
                  ...client,
                  request: (method, params) =>
                    Effect.sync(() => {
                      if (method === "thread/start") sent.push(params);
                    }).pipe(Effect.andThen(client.request(method, params))),
                }) satisfies CodexClient.CodexAppServerClient["Service"],
            ),
            Effect.orDie,
          ),
      },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
      continuationRequests: { offer: () => Effect.void },
    });
    const modelSelection = {
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      model: "gpt-5.6-sol",
    };
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${scenario}`),
      modelSelection,
      runtimePolicy,
    });
    yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    assert.lengthOf(sent, 1);
    return (sent[0] as { readonly config: Readonly<Record<string, unknown>> }).config;
  });

describe("Crew seat question tools on Codex", () => {
  it.effect("turns request_user_input off in a seat's thread config and nowhere else", () =>
    Effect.gen(function* () {
      const seat = yield* threadStartConfig("codex-crew-seat", seatPolicy, {
        ...CodexAdapterV2.CODEX_THREAD_CONFIG,
        ...J5_CODEX_CREW_SEAT_CONFIG,
      });
      assert.strictEqual(seat["features.default_mode_request_user_input"], false);
      assert.strictEqual(seat["tools.experimental_request_user_input.enabled"], false);
      assert.property(seat, "mcp_servers.t3-code");

      const captain = yield* threadStartConfig(
        "codex-crew-captain",
        basePolicy,
        CodexAdapterV2.CODEX_THREAD_CONFIG,
      );
      for (const key of Object.keys(J5_CODEX_CREW_SEAT_CONFIG)) assert.notProperty(captain, key);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("sends the ask-your-Captain rule with a seat's turn and no other", () =>
    Effect.gen(function* () {
      const turn = (runtimePolicy: typeof basePolicy) =>
        buildCodexTurnStartParams({
          nativeThreadId: "native-crew-seat",
          codexInput: [{ type: "text", text: "review the change" }],
          runtimePolicy,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
          hasT3Mcp: true,
        });
      const seat = yield* turn(seatPolicy);
      assert.deepEqual(seat.additionalContext?.j5_agent_persona, {
        kind: "application",
        value: CREW_SEAT_QUESTION_INSTRUCTIONS,
      });
      const captain = yield* turn(basePolicy);
      assert.notProperty(captain.additionalContext, "j5_agent_persona");
    }),
  );
});
