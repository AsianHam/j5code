import { AuthAccessWriteScope, AuthOrchestrationOperateScope } from "../auth.ts";
import { J5_CLIENT_ACTION_WS_METHODS } from "../j5.ts";
import { J5_AGENT_PERSONA_WS_METHODS } from "./agentPersona.ts";
import { J5_ARTIFACT_WS_METHODS } from "./artifacts.ts";
import { J5_PLAYBOOK_WS_METHODS } from "./playbook.ts";
import { J5_SHARING_WS_METHODS } from "./sharing.ts";
import { J5_SKILL_CATALOG_WS_METHODS } from "./skillCatalog.ts";
import { J5_SKILL_LINK_WS_METHODS } from "./skillLinks.ts";

/**
 * J5's RPC methods that change something, each with the scope the server requires for it. Spread
 * into upstream's `CLIENT_GUARDED_RPC_SCOPES`, so a J5 command built with
 * `createEnvironmentRpcCommand` reports its availability through `permissionAtom` and is checked
 * again when it runs. Reads are left out: a guarded method cannot back a query.
 */
export const J5_CLIENT_GUARDED_RPC_SCOPES = {
  [J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.createAgentPersona]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaLibraryFolders]: AuthOrchestrationOperateScope,
  [J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaEnabled]: AuthOrchestrationOperateScope,

  [J5_SKILL_CATALOG_WS_METHODS.applySkillCatalogGroups]: AuthOrchestrationOperateScope,
  [J5_SKILL_CATALOG_WS_METHODS.updateSkillCatalog]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.remove]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.unlink]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.delete]: AuthOrchestrationOperateScope,

  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: AuthOrchestrationOperateScope,
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: AuthOrchestrationOperateScope,
  [J5_ARTIFACT_WS_METHODS.deleteArtifact]: AuthOrchestrationOperateScope,

  [J5_CLIENT_ACTION_WS_METHODS.resolveCrewProposal]: AuthOrchestrationOperateScope,
  [J5_CLIENT_ACTION_WS_METHODS.stopCrew]: AuthOrchestrationOperateScope,
  [J5_CLIENT_ACTION_WS_METHODS.archiveCrew]: AuthOrchestrationOperateScope,
  [J5_CLIENT_ACTION_WS_METHODS.respondCrewRuntimeRequest]: AuthOrchestrationOperateScope,
  [J5_CLIENT_ACTION_WS_METHODS.answerHumanExchange]: AuthOrchestrationOperateScope,

  [J5_CLIENT_ACTION_WS_METHODS.issuePeerCredential]: AuthAccessWriteScope,
  [J5_CLIENT_ACTION_WS_METHODS.addPeer]: AuthAccessWriteScope,
  [J5_CLIENT_ACTION_WS_METHODS.removePeer]: AuthAccessWriteScope,
  [J5_CLIENT_ACTION_WS_METHODS.listPeerAddresses]: AuthAccessWriteScope,
  [J5_CLIENT_ACTION_WS_METHODS.probePeer]: AuthAccessWriteScope,

  [J5_SHARING_WS_METHODS.createGuest]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.putGrant]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.removeGrant]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.removePerson]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.revokeDevice]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.createLink]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.renamePerson]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.setOwnerName]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.revokeLink]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.createOpenLink]: AuthAccessWriteScope,
  [J5_SHARING_WS_METHODS.revokeOpenLink]: AuthAccessWriteScope,
} as const;
