import { assert, describe, it } from "@effect/vitest";

import { OrchestratorMcpDelegateTaskInput } from "@t3tools/contracts";

import {
  J5_DELEGATE_TASK_DESCRIPTION,
  J5DelegateTaskInput,
  J5DelegateTaskTool,
} from "./agentDelegation.ts";

describe("J5 delegate_task description", () => {
  it("leads with the saved-agent use and keeps ordinary subagent requests provider-native", () => {
    assert.equal(J5DelegateTaskTool.description, J5_DELEGATE_TASK_DESCRIPTION);
    assert.include(
      J5_DELEGATE_TASK_DESCRIPTION,
      "Pass persona=ID when the user writes @persona:ID",
    );
    assert.include(J5_DELEGATE_TASK_DESCRIPTION, "omit target and runtimeMode");
    assert.include(J5_DELEGATE_TASK_DESCRIPTION, "provider's native subagent mechanism");
    // Upstream's opening sentences would make this tool the default for any subagent request.
    assert.notInclude(J5_DELEGATE_TASK_DESCRIPTION, "Use this whenever the user asks for an agent");
    // Upstream's text comes after J5's persona rules; its mechanics are on the fields J5 reuses.
    assert.include(
      J5_DELEGATE_TASK_DESCRIPTION,
      "Separate checkout or PR per child: `isolation:'worktree'`",
    );
    for (const field of ["target", "isolation", "mode", "timeoutMs", "runtimeMode"] as const) {
      assert.strictEqual(
        J5DelegateTaskInput.fields[field],
        OrchestratorMcpDelegateTaskInput.fields[field],
      );
    }
  });
});
