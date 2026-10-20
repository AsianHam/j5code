import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
} from "../auth.ts";
import { J5_CLIENT_ACTION_WS_METHODS } from "../j5.ts";
import { J5_AGENT_PERSONA_WS_METHODS } from "./agentPersona.ts";
import { J5_ARTIFACT_WS_METHODS } from "./artifacts.ts";
import { J5_ACCESS_WS_METHODS } from "./access.ts";
import { J5_PEOPLE_WS_METHODS } from "./people.ts";
import { J5_PLAYBOOK_WS_METHODS } from "./playbook.ts";
import { J5_SKILL_CATALOG_WS_METHODS } from "./skillCatalog.ts";
import { J5_SKILL_LINK_WS_METHODS } from "./skillLinks.ts";

/**
 * J5's RPC methods that change something, each with the scope the server requires for it. Spread
 * into upstream's `CLIENT_GUARDED_RPC_SCOPES`, so a J5 command built with
 * `createEnvironmentRpcCommand` reports its availability through `permissionAtom` and is checked
 * again when it runs. Reads are left out: a guarded method cannot back a query.
 */
export const J5_CLIENT_GUARDED_RPC_SCOPES = {
  // The Persona library, like the Playbook library below, is changed by Owners only.
  [J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.createAgentPersona]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaLibraryFolders]: AuthSettingsWriteScope,
  [J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaEnabled]: AuthSettingsWriteScope,

  [J5_SKILL_CATALOG_WS_METHODS.applySkillCatalogGroups]: AuthProvidersManageScope,
  [J5_SKILL_CATALOG_WS_METHODS.updateSkillCatalog]: AuthProvidersManageScope,
  [J5_SKILL_LINK_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.remove]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.unlink]: AuthOrchestrationOperateScope,
  [J5_SKILL_LINK_WS_METHODS.delete]: AuthOrchestrationOperateScope,

  // The server's library is changed by its Owners only.
  [J5_PLAYBOOK_WS_METHODS.savePlaybook]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.setFolders]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: AuthSettingsWriteScope,
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

  // A connection's own place on the server: saying whose its device is, naming the first owner,
  // leaving a scope, renaming oneself, an Owner marking a notice seen. Every device holds what
  // they need; the server checks each against the session itself.
  [J5_ACCESS_WS_METHODS.claimDevice]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.setFirstOwnerName]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.leave]: AuthOrchestrationReadScope,
  [J5_ACCESS_WS_METHODS.markRetiredLinksSeen]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.renameSelf]: AuthOrchestrationReadScope,

  [J5_PEOPLE_WS_METHODS.setLevel]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.removeLevel]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.removePerson]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.renamePerson]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.revokeDevice]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.createLink]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.revokeLink]: AuthAccessWriteScope,
} as const;
