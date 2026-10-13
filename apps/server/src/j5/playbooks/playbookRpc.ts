import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5_PLAYBOOK_WS_METHODS,
  type PlaybookDeleteRequest,
  type PlaybookExportRequest,
  type PlaybookLibraryRequest,
  type PlaybookRenameRequest,
  type PlaybookRunsRequest,
  type ThreadPlaybooksRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { playbookError, type PlaybookStore } from "./PlaybookStore.ts";
import { makeWorkspacePlaybooks } from "./WorkspacePlaybooks.ts";

export const PLAYBOOK_RPC_SCOPES = {
  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.readLibrary]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.listRuns]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: AuthOrchestrationOperateScope,
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: AuthOrchestrationOperateScope,
} as const;

const failed = (message: string) => (cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(playbookError("operation_failed", message))),
  );

/**
 * Share the server's store revision through the authenticated WebSocket connection; read runs;
 * and read, export, delete and rename definitions in the workspace a request names.
 */
export const makePlaybookRpcHandlers = Effect.fn("makePlaybookRpcHandlers")(function* (options: {
  readonly store: Pick<PlaybookStore["Service"], "changes" | "listForThread" | "listAll"> &
    Parameters<typeof makeWorkspacePlaybooks>[0];
}) {
  const { store } = options;
  const workspace = yield* makeWorkspacePlaybooks(store);
  return {
    [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () => store.changes,
    [J5_PLAYBOOK_WS_METHODS.readLibrary]: (input: PlaybookLibraryRequest) =>
      workspace.library(input),
    [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: (input: typeof ThreadPlaybooksRequest.Type) =>
      store
        .listForThread(input.threadId)
        .pipe(Effect.catch(failed("Reading the thread's playbook runs failed."))),
    [J5_PLAYBOOK_WS_METHODS.listRuns]: (input: PlaybookRunsRequest) =>
      store.listAll(input).pipe(Effect.catch(failed("Reading playbook runs failed."))),
    [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: (input: PlaybookExportRequest) =>
      workspace.exportDefinition(input),
    [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: (input: PlaybookDeleteRequest) =>
      workspace.removeDefinition(input),
    [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: (input: PlaybookRenameRequest) =>
      workspace.renameDefinition(input),
  };
});
