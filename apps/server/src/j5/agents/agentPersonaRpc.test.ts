import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  J5_AGENT_PERSONA_WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";

describe("agent persona RPC scopes", () => {
  it("requires an Owner's settings permission to import, edit, toggle, or remove persona definitions", () => {
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.createAgentPersona)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.readAgentPersona)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona)).toBe(
      AuthSettingsWriteScope,
    );
    expect(
      requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled),
    ).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaUsage)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(
      requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaLibrarySources),
    ).toBe(AuthOrchestrationReadScope);
    expect(
      requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaLibraryFolders),
    ).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaEnabled)).toBe(
      AuthSettingsWriteScope,
    );
    for (const method of [
      J5_AGENT_PERSONA_WS_METHODS.listAgentPersonaImportFiles,
      J5_AGENT_PERSONA_WS_METHODS.readAgentPersonaImportFiles,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    }
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.getAgentHandoffs)).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
