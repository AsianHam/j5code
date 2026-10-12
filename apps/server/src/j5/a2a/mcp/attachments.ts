import { type ChatAttachment, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import { ServerSecretStore } from "../../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../../config.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { readThread } from "../../../mcp/threadAccess.ts";
import { resolveAttachmentReferences } from "../../../mcp/toolkits/attachment/handlers.ts";
import type { McpAttachmentInput } from "../../../mcp/toolkits/attachment/input.ts";
import { AttachmentToolkit } from "../../../mcp/toolkits/attachment/tools.ts";
import {
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../../../orchestration-v2/AttachmentClaims.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { isSendRefusal } from "../SendService.ts";

/**
 * Upstream's upload tools on upstream's handlers. `t3_attachment_prepare_upload` is re-declared
 * for one sentence: upstream's description sends the upload to `t3_thread_send_attachments`,
 * which J5 does not register. An agent attaches a file with `j5_send_message` or to a
 * `j5_spawn_agent` brief.
 */
export const J5AttachmentUploadToolkit = Toolkit.make(
  Tool.make("t3_attachment_prepare_upload", {
    description:
      "Create the app's signed upload URL. POST the exact bytes to relativeUrl on this MCP server's HTTP origin, then pass the attachment metadata and returned ID in the attachments of j5_send_message or j5_spawn_agent. Upload is separate from sending; provider attachment support is decided by its adapter.",
    parameters: AttachmentToolkit.tools.t3_attachment_prepare_upload.parametersSchema,
    success: AttachmentToolkit.tools.t3_attachment_prepare_upload.successSchema,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext,
      ThreadManagementService,
      ServerConfig,
      ServerSecretStore,
      FileSystem.FileSystem,
      Crypto.Crypto,
    ],
  }).annotate(Tool.Destructive, true),
  AttachmentToolkit.tools.t3_attachment_discard,
);

/**
 * Sends a message with files for an agent on this server. Each attachment is a pending upload,
 * or one the receiver's thread already holds, and is claimed into that thread before `send`
 * commits the message. A send the ledger refuses committed nothing, so its claims are released;
 * any other failure leaves acceptance uncertain, and the claims stay.
 */
export const sendClaimingAttachments = Effect.fn("j5.a2a.mcp.sendClaimingAttachments")(function* <
  A,
  E,
  R,
>(
  receiverThreadId: ThreadId,
  attachments: ReadonlyArray<typeof McpAttachmentInput.Type>,
  send: (claimed: ReadonlyArray<ChatAttachment>) => Effect.Effect<A, E, R>,
) {
  const { projection } = yield* readThread(receiverThreadId, ["messages"]);
  const references = yield* resolveAttachmentReferences(
    attachments,
    projection.messages.flatMap((message) => message.attachments),
  );
  const claimed = yield* claimPendingAttachments({
    threadId: receiverThreadId,
    attachments: references,
  });
  return yield* send(claimed.attachments).pipe(
    Effect.tapError((error) =>
      isSendRefusal(error) ? releaseClaimedAttachments(claimed.claimedPaths) : Effect.void,
    ),
  );
});
