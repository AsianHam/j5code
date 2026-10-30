import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { probeClaudeCapabilities } from "../../provider/ClaudeProvider.ts";

// The machine capability probe reports Claude's bundled (builtin) skills from
// `reload_skills`, and that optional request never discards initialization.
vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.effect("reports bundled skills while optional usage times out", () =>
  Effect.gen(function* () {
    const usageStarted = yield* Deferred.make<void>();
    const reloadedSkills = [
      { name: "simplify", description: " Simplify code ", argumentHint: "", builtin: true },
      { name: "review", description: "Review changes", argumentHint: "[path]" },
    ];
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async (): Promise<ClaudeSdk.SDKControlInitializeResponse> => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          agents: [],
          models: [],
          output_style: "default",
          available_output_styles: ["default"],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          Deferred.doneUnsafe(usageStarted, Effect.void);
          return new Promise<ClaudeSdk.SDKControlGetUsageResponse>(() => {});
        },
        reloadSkills: async (): Promise<ClaudeSdk.SDKControlReloadSkillsResponse> => ({
          skills: reloadedSkills,
        }),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(usageStarted);
    yield* TestClock.adjust("4 seconds");
    const capabilities = yield* Fiber.join(probe);
    assert.equal(capabilities?.email, "dev@example.com");
    assert.equal(capabilities?.usage, undefined);
    // Only builtin skills are bundled; discovery reports the rest from disk.
    assert.deepEqual(
      capabilities?.bundledSkills.map(({ name, description, scope, enabled }) => ({
        name,
        description,
        scope,
        enabled,
      })),
      [{ name: "simplify", description: "Simplify code", scope: "builtin", enabled: true }],
    );
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["timeout", "rejection"] as const)(
  "preserves initialized capabilities when skill reload ends in %s",
  (failure) =>
    Effect.gen(function* () {
      const reloadStarted = yield* Deferred.make<void>();
      let abortSignal: AbortSignal | undefined;
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        abortSignal = options?.abortController?.signal;
        return {
          initializationResult: async () => ({
            account: { email: "dev@example.com" },
            commands: [{ name: "simplify", description: "Simplify code", argumentHint: "" }],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            rate_limits_available: false,
            rate_limits: {},
          }),
          reloadSkills: () => {
            Deferred.doneUnsafe(reloadStarted, Effect.void);
            return failure === "timeout"
              ? new Promise(() => {})
              : Promise.reject(new Error("Unsupported control request"));
          },
        } as ReturnType<typeof ClaudeSdk.query>;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const probe = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: "claude" }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(reloadStarted);
      if (failure === "timeout") yield* TestClock.adjust("4 seconds");
      const capabilities = yield* Fiber.join(probe);
      assert.equal(capabilities?.email, "dev@example.com");
      assert.deepEqual(capabilities?.slashCommands, [
        { name: "simplify", description: "Simplify code" },
      ]);
      assert.deepEqual(capabilities?.bundledSkills, []);
      assert.deepEqual(capabilities?.usage, { rate_limits_available: false, rate_limits: {} });
      assert.equal(abortSignal?.aborted, true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
