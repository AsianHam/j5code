import { CLIENT_ACTION_RPC_SCOPES } from "./a2a/clientActionRpc.ts";
import { AGENT_PERSONA_RPC_SCOPES } from "./agents/agentPersonaRpc.ts";
import { ARTIFACT_RPC_SCOPES } from "./artifacts/artifactRpc.ts";
import { PLAYBOOK_RPC_SCOPES } from "./playbooks/playbookRpc.ts";
import { SHARING_RPC_SCOPES } from "./sharing/sharingRpc.ts";
import { SKILL_CATALOG_RPC_SCOPES } from "./skills/skillCatalogRpc.ts";
import { SKILL_LINK_RPC_SCOPES } from "./skills/skillLinkRpc.ts";

/**
 * The scope every J5 WebSocket RPC requires, spread into upstream's table in
 * `auth/RpcAuthorization.ts`. That table must name every method of `WsRpcGroup`, so a J5 RPC
 * group merged into it needs its scopes here.
 */
export const J5_RPC_SCOPES = {
  ...AGENT_PERSONA_RPC_SCOPES,
  ...ARTIFACT_RPC_SCOPES,
  ...SKILL_CATALOG_RPC_SCOPES,
  ...SKILL_LINK_RPC_SCOPES,
  ...PLAYBOOK_RPC_SCOPES,
  ...CLIENT_ACTION_RPC_SCOPES,
  ...SHARING_RPC_SCOPES,
} as const;
