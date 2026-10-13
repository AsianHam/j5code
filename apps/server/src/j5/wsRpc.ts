import {
  J5AgentPersonaRpcGroup,
  J5ArtifactRpcGroup,
  J5SkillCatalogRpcGroup,
  J5SkillLinkRpcGroup,
  SkillLinkError,
} from "@t3tools/contracts";
import {
  J5ClientActionRpcGroup,
  J5ClientReadRpcGroup,
  J5PlaybookRpcGroup,
  J5SharingRpcGroup,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeClientActionRpcHandlers } from "./a2a/clientActionRpc.ts";
import { ClientActionsService } from "./a2a/ClientActionsService.ts";
import { makeClientReadRpcHandlers } from "./a2a/clientReadRpc.ts";
import { ClientReadsService } from "./a2a/ClientReadsService.ts";
import { PeerAdminService } from "./a2a/PeerAdminService.ts";
import { ReadChanges } from "./a2a/ReadChanges.ts";
import { makeAgentPersonaRpcHandlers } from "./agents/agentPersonaRpc.ts";
import { ArtifactDeletion } from "./artifacts/ArtifactDeletion.ts";
import { makeArtifactRpcHandlers } from "./artifacts/artifactRpc.ts";
import type { ArtifactWorkspace } from "./artifacts/ArtifactWorkspace.ts";
import { PlaybookStore } from "./playbooks/PlaybookStore.ts";
import { makePlaybookRpcHandlers } from "./playbooks/playbookRpc.ts";
import { PersonAccess, type SessionIdentity } from "./sharing/PersonAccess.ts";
import { makeSharingRpcHandlers } from "./sharing/sharingRpc.ts";
import { makeSkillCatalogRpcHandlers } from "./skills/skillCatalogRpc.ts";
import { makeSkillLinkRpcHandlers } from "./skills/skillLinkRpc.ts";

/** J5's own WebSocket RPCs: the groups `WsRpcGroup` merges into upstream's in contracts. */
const J5WsRpcGroup = J5AgentPersonaRpcGroup.merge(
  J5ArtifactRpcGroup,
  J5SkillCatalogRpcGroup,
  J5SkillLinkRpcGroup,
  J5PlaybookRpcGroup,
  J5ClientActionRpcGroup,
  J5SharingRpcGroup,
  J5ClientReadRpcGroup,
);

/** Every J5 RPC method, for `ws.ts` to leave out of the group upstream's handlers are typed by. */
export const J5_WS_RPC_METHODS = [...J5WsRpcGroup.requests.keys()] as ReadonlyArray<
  RpcGroup.Rpcs<typeof J5WsRpcGroup>["_tag"]
>;

type J5WsRpcServices =
  | ClientActionsService
  | ClientReadsService
  | PeerAdminService
  | ReadChanges
  | ArtifactDeletion
  | PersonAccess;

/**
 * The server-lifetime J5 services the handlers call. `ws.ts` reads them once, where its route is
 * built, and hands them to every socket's handler layer.
 */
export const j5WsRpcServices = Effect.context<J5WsRpcServices>().pipe(
  // Only these: the whole server context laid over a socket's would shadow that socket's own.
  Effect.map(
    Context.pick(
      ClientActionsService,
      ClientReadsService,
      PeerAdminService,
      ReadChanges,
      ArtifactDeletion,
      PersonAccess,
    ),
  ),
);

/**
 * The handlers of J5's RPCs, as their own layer beside upstream's in `ws.ts`. A handler is
 * looked up by method, so the socket serves both from one group. They are built apart because
 * one handler record for upstream's RPCs and J5's together exceeds TypeScript's type
 * instantiation limit.
 */
export const layerJ5WsRpc = (
  artifactWorkspace: ArtifactWorkspace["Service"],
  services: Context.Context<J5WsRpcServices>,
  session: SessionIdentity,
) =>
  J5WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      return J5WsRpcGroup.of({
        ...makeArtifactRpcHandlers({
          projects,
          artifacts: artifactWorkspace,
          deletion: yield* ArtifactDeletion,
        }),
        ...(yield* makeClientActionRpcHandlers()),
        ...(yield* makeClientReadRpcHandlers()),
        ...(yield* makeAgentPersonaRpcHandlers({
          providers: providerRegistry.getProviders,
        })),
        ...(yield* makeSkillCatalogRpcHandlers()),
        ...(yield* makeSkillLinkRpcHandlers({
          getProjectRoot: (projectId) =>
            projects.getById(projectId).pipe(
              Effect.map((project) =>
                Option.isSome(project) ? project.value.workspaceRoot : undefined,
              ),
              Effect.mapError((cause) => new SkillLinkError({ message: String(cause) })),
            ),
        })),
        ...(yield* makePlaybookRpcHandlers({ store: yield* PlaybookStore })),
        ...makeSharingRpcHandlers({ access: yield* PersonAccess, session }),
      });
    }),
  ).pipe(Layer.provide(Layer.succeedContext(services)));
