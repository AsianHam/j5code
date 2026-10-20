import { describe, expect, it } from "@effect/vitest";

import { AuthAccessWriteScope, AuthOrchestrationOperateScope } from "../auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "../clientRpcPermissions.ts";
import { J5_CLIENT_ACTION_WS_METHODS } from "../j5.ts";
import { WsRpcGroup } from "../rpc.ts";
import { J5_CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import { J5_PLAYBOOK_WS_METHODS } from "./playbook.ts";

describe("J5 client RPC permissions", () => {
  it("names only methods the socket serves, and none that streams", () => {
    for (const method of Object.keys(J5_CLIENT_GUARDED_RPC_SCOPES)) {
      const rpc = WsRpcGroup.requests.get(method);
      expect(rpc, method).toBeDefined();
      // A guarded method backs a command; a subscription is a read.
      expect(method, method).not.toMatch(/subscribe/i);
      // Tests that walk J5's entries of the merged map find them by this prefix.
      expect(method, method).toMatch(/^j5\./);
    }
  });

  it("are part of the map upstream's guard reads, with their own scopes", () => {
    for (const [method, scope] of Object.entries(J5_CLIENT_GUARDED_RPC_SCOPES)) {
      expect(clientRpcRequiredScopes(method, undefined), method).toEqual([scope]);
    }
    expect(CLIENT_GUARDED_RPC_SCOPES[J5_PLAYBOOK_WS_METHODS.deletePlaybook]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(CLIENT_GUARDED_RPC_SCOPES[J5_CLIENT_ACTION_WS_METHODS.addPeer]).toBe(
      AuthAccessWriteScope,
    );
  });

  it("leave reads unguarded, so a read-only session can still load them", () => {
    for (const method of [
      J5_PLAYBOOK_WS_METHODS.exportPlaybook,
      J5_PLAYBOOK_WS_METHODS.readSources,
      J5_PLAYBOOK_WS_METHODS.readLibrary,
      J5_PLAYBOOK_WS_METHODS.subscribeChanges,
      J5_CLIENT_ACTION_WS_METHODS.previewCrewProposal,
    ]) {
      expect(clientRpcRequiredScopes(method, undefined), method).toEqual([]);
    }
  });
});
