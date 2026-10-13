import {
  J5_AGENT_PERSONA_WS_METHODS,
  J5_ARTIFACT_WS_METHODS,
  J5_SKILL_CATALOG_WS_METHODS,
  J5_SKILL_LINK_WS_METHODS,
} from "@t3tools/contracts";
import {
  J5_CLIENT_ACTION_WS_METHODS,
  J5_CLIENT_READ_WS_METHODS,
  J5_PLAYBOOK_WS_METHODS,
  J5_SHARING_WS_METHODS,
} from "@t3tools/contracts/j5";

const labelled = <const Methods extends Readonly<Record<string, string>>>(
  methods: Methods,
  aggregate: string,
) =>
  Object.fromEntries(Object.values(methods).map((method) => [method, aggregate])) as Readonly<
    Record<Methods[keyof Methods], string>
  >;

/**
 * The `rpc.aggregate` span label of every J5 WebSocket RPC, spread into upstream's table in
 * `observability/RpcInstrumentation.ts`. That table must name every method of `WsRpcGroup`, so
 * a J5 RPC group merged into it needs its label here.
 */
export const J5_RPC_AGGREGATES = {
  ...labelled(J5_AGENT_PERSONA_WS_METHODS, "j5AgentPersonas"),
  ...labelled(J5_ARTIFACT_WS_METHODS, "artifacts"),
  ...labelled(J5_SKILL_CATALOG_WS_METHODS, "j5SkillCatalog"),
  ...labelled(J5_SKILL_LINK_WS_METHODS, "j5SkillLinks"),
  ...labelled(J5_PLAYBOOK_WS_METHODS, "j5Playbooks"),
  ...labelled(J5_CLIENT_ACTION_WS_METHODS, "j5ClientActions"),
  ...labelled(J5_SHARING_WS_METHODS, "j5Sharing"),
  ...labelled(J5_CLIENT_READ_WS_METHODS, "j5ClientReads"),
};
