import * as Layer from "effect/Layer";

import { layer as ArtifactWorkspaceLive } from "../../artifacts/ArtifactWorkspace.ts";
import * as ArtifactMcpService from "../../../mcp/ArtifactMcpService.ts";
import type { toolkitRegistration } from "../../../mcp/McpHttpServer.ts";
import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../../mcp/ThreadMetadataMcpService.ts";
import * as ArtifactHandlers from "../../../mcp/toolkits/artifacts/handlers.ts";
import { ArtifactToolkit } from "../../../mcp/toolkits/artifacts/tools.ts";
import * as AttachmentHandlers from "../../../mcp/toolkits/attachment/handlers.ts";
import * as EnvironmentHandlers from "../../../mcp/toolkits/environment/handlers.ts";
import * as OrchestratorHandlers from "../../../mcp/toolkits/orchestrator/handlers.ts";
import * as ProjectHandlers from "../../../mcp/toolkits/project/handlers.ts";
import * as ThreadHandlers from "../../../mcp/toolkits/thread/handlers.ts";
import { J5AttachmentUploadToolkit } from "./attachments.ts";
import * as J5Handlers from "./handlers.ts";
import { J5OrchestratorSurface } from "./orchestratorSurface.ts";
import * as J5OrchestratorSurfaceHandlers from "./orchestratorSurfaceHandlers.ts";
import * as J5AdaptedThread from "./threadTools.ts";
import { J5Toolkit } from "./tools.ts";
import {
  J5EnvironmentToolkit,
  J5OrchestratorToolkit,
  J5ProjectToolkit,
  J5ThreadToolkit,
  handlersFor,
} from "./upstreamCatalog.ts";

/**
 * Everything J5 puts on `/mcp` besides the upstream toolkits it registers whole: J5's own
 * tools, and the admitted part of upstream's orchestrator, thread, attachment, project and
 * environment toolkits on upstream's own handlers. `register` is McpHttpServer's
 * `toolkitRegistration`, passed in because that module imports this one; it takes only handlers
 * McpToolAccess built, so every tool here has declared who may call it.
 */
export const layerJ5Toolkits = (register: typeof toolkitRegistration) =>
  Layer.mergeAll(
    register(J5Toolkit, J5Handlers.layer).pipe(Layer.provide(OrchestratorMcpService.layer)),
    register(J5OrchestratorSurface, J5OrchestratorSurfaceHandlers.layer).pipe(
      Layer.provide(OrchestratorMcpService.layer),
    ),
    register(
      J5OrchestratorToolkit,
      handlersFor(J5OrchestratorToolkit, OrchestratorHandlers.layer),
    ).pipe(
      Layer.provide(OrchestratorMcpService.layer),
      Layer.provide(ThreadMetadataMcpService.layer),
    ),
    register(J5ThreadToolkit, handlersFor(J5ThreadToolkit, ThreadHandlers.layer)),
    register(J5AdaptedThread.J5AdaptedThreadToolkit, J5AdaptedThread.layer),
    register(
      J5AttachmentUploadToolkit,
      handlersFor(J5AttachmentUploadToolkit, AttachmentHandlers.layer),
    ),
    register(J5ProjectToolkit, handlersFor(J5ProjectToolkit, ProjectHandlers.layer)),
    register(J5EnvironmentToolkit, handlersFor(J5EnvironmentToolkit, EnvironmentHandlers.layer)),
    register(ArtifactToolkit, ArtifactHandlers.layer).pipe(
      Layer.provide(ArtifactMcpService.layer.pipe(Layer.provide(ArtifactWorkspaceLive))),
    ),
  );
