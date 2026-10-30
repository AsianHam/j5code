import {
  ArtifactContent,
  ArtifactListResponse,
  ArtifactMcpFailure,
  ArtifactReadInput,
  ArtifactWriteInput,
  ArtifactWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ArtifactMcpService } from "../../ArtifactMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// McpToolAccess reads the calling thread before each tool, hence ThreadManagementService.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService,
  ArtifactMcpService,
];
/** An artifact refusal, or McpToolAccess's refusal of a caller that is not a live thread. */
const failure = Schema.Union([ArtifactMcpFailure, OrchestratorMcpFailure]);

export const ListArtifactsTool = Tool.make("j5_list_artifacts", {
  description:
    "List durable planning artifacts shared by every thread and agent in the current project.",
  success: ArtifactListResponse,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List project artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ReadArtifactTool = Tool.make("j5_read_artifact", {
  description:
    "Read one project artifact by its path relative to artifacts/, such as plan.md or diagrams/flow.svg.",
  parameters: ArtifactReadInput,
  success: ArtifactContent,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a project artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const WriteArtifactTool = Tool.make("j5_write_artifact", {
  description:
    "Create or replace a durable, user-consumable planning artifact shared across the current project's threads and agents. Use this for plans, specifications, diagrams, and research notes (not source code, build output, logs, scratch files, or ordinary repository documentation). The path is relative to artifacts/ and content must be UTF-8 text; HTML, Markdown, Mermaid, and SVG are supported. Paths under handoffs/ keep history: writing an existing handoff adds your content as a new version at the top of the same file instead of replacing it, so j5_read_artifact on such a path returns a versions header followed by every kept version, newest first.",
  parameters: ArtifactWriteInput,
  success: ArtifactWriteResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write a project artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ArtifactToolkit = Toolkit.make(ListArtifactsTool, ReadArtifactTool, WriteArtifactTool);
