import { assert, describe, it } from "@effect/vitest";
import {
  type AgentPersonaAuthorityPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildCodexTurnStartParams } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  claudeRuntimeQueryPolicyForRuntimePolicy,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import { antigravityPermissionMode } from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  agentPersonaPolicyEnforcement,
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "./agentPersonaProviderPolicy.ts";

const runtimePolicy = (authorityPolicy: AgentPersonaAuthorityPolicy, driver = "codex") => ({
  ...translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make(driver)),
  interactionMode: "default" as const,
  cwd: "/workspace",
});

describe("agent persona provider policy", () => {
  it("translates inspection policies to non-interactive read-only access", () => {
    for (const authorityPolicy of ["read-only", "critic-review"] as const) {
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make("codex")),
        {
          runtimeMode: "approval-required",
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      );
    }
  });

  it("translates editing policies to workspace-scoped writes", () => {
    for (const authorityPolicy of ["workspace-write", "critic-fix"] as const) {
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make("codex")),
        {
          runtimeMode: "auto-accept-edits",
          approvalPolicy: "never",
          sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        },
      );
    }
  });

  it("fails closed to read-only when a provider cannot enforce the authority", () => {
    for (const [authorityPolicy, driver] of [
      ["workspace-write", "claudeAgent"],
      ["critic-fix", "claudeAgent"],
      ["diagnostic", "codex"],
      ["publish-only", "codex"],
    ] as const) {
      assert.isFalse(
        providerCanEnforceAgentPersonaAuthority(ProviderDriverKind.make(driver), authorityPolicy),
      );
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make(driver)),
        {
          runtimeMode: "approval-required",
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      );
    }
  });

  it("never enforces or translates a policy only a newer server knows", () => {
    assert.isFalse(
      providerCanEnforceAgentPersonaAuthority(
        ProviderDriverKind.make("codex"),
        "sandboxed-network",
      ),
    );
    assert.throws(
      () =>
        translateAgentPersonaProviderPolicy(
          // @ts-expect-error a stored policy from a newer server, as an untyped caller would pass it
          "sandboxed-network",
          ProviderDriverKind.make("codex"),
        ),
      /sandboxed-network/,
    );
  });

  it.effect("compiles the canonical policies into Codex turn settings", () =>
    Effect.gen(function* () {
      const build = (authorityPolicy: AgentPersonaAuthorityPolicy) =>
        buildCodexTurnStartParams({
          nativeThreadId: `native-${authorityPolicy}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: runtimePolicy(authorityPolicy),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-terra",
          },
        });

      const readOnly = yield* build("critic-review");
      const workspaceWrite = yield* build("critic-fix");
      const publish = yield* build("publish-only");

      assert.equal(readOnly.approvalPolicy, "never");
      assert.equal(readOnly.sandboxPolicy?.type, "readOnly");
      assert.equal(workspaceWrite.approvalPolicy, "never");
      assert.equal(workspaceWrite.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(publish.approvalPolicy, "never");
      assert.equal(publish.sandboxPolicy?.type, "readOnly");
    }),
  );

  it("compiles the canonical policies into Claude permission modes", () => {
    assert.deepEqual(claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy("critic-review")), {
      permissionMode: "dontAsk",
      tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
    assert.deepEqual(
      claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy("critic-fix", "claudeAgent")),
      {
        permissionMode: "dontAsk",
        tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        installPermissionCallback: false,
      },
    );
    assert.deepEqual(claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy("publish-only")), {
      permissionMode: "dontAsk",
      tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });
});

describe("full-access agent persona policy", () => {
  const FULL_ACCESS_DRIVERS = [
    "codex",
    "claudeAgent",
    "cursor",
    "opencode",
    "grok",
    "antigravity",
    "pi",
    "acpRegistry",
  ] as const;

  it("adds no J5 restriction beyond the ordinary full-access runtime mode", () => {
    for (const driver of FULL_ACCESS_DRIVERS) {
      assert.isTrue(providerCanEnforceAgentPersonaAuthority(driver, "full-access"));
      assert.deepEqual(
        translateAgentPersonaProviderPolicy("full-access", ProviderDriverKind.make(driver)),
        { runtimeMode: "full-access" },
      );
    }
    assert.isFalse(providerCanEnforceAgentPersonaAuthority("unknown", "full-access"));
    assert.deepEqual(translateAgentPersonaProviderPolicy("full-access", "unknown"), {
      runtimeMode: "approval-required",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
    });
    assert.deepEqual(
      agentPersonaPolicyEnforcement().find(({ policy }) => policy === "full-access")?.drivers,
      FULL_ACCESS_DRIVERS.map((driver) => ProviderDriverKind.make(driver)),
    );
  });

  it.effect("runs unsandboxed with approvals off on Codex", () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-full-access",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: runtimePolicy("full-access"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" },
      });
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it("bypasses permission prompts on Claude", () => {
    const policy = claudeRuntimeQueryPolicyForRuntimePolicy(
      runtimePolicy("full-access", "claudeAgent"),
    );
    assert.equal(policy.permissionMode, "bypassPermissions");
    assert.isUndefined(policy.tools);
    assert.isUndefined(policy.allowedTools);
  });

  it("starts Antigravity in yolo mode", () => {
    assert.equal(
      antigravityPermissionMode(runtimePolicy("full-access", "antigravity").runtimeMode),
      "yolo",
    );
  });

  it("lets ACP registry harnesses run commands without asking", () => {
    const request = {
      sessionId: "session",
      toolCall: { toolCallId: "call", kind: "execute" },
      options: [],
    } as never;
    assert.equal(
      acpPermissionDisposition(runtimePolicy("full-access", "acpRegistry"), request),
      "allow",
    );
  });
});
