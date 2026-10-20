import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  J5_PLAYBOOK_WS_METHODS,
  type PlaybookDeleteRequest,
  type PlaybookError,
  type PlaybookSaveRequest,
  type PlaybookFoldersInput,
  type PlaybookExportRequest,
  type PlaybookLibraryRequest,
  type PlaybookRenameRequest,
  type PlaybookRunsRequest,
  type ThreadPlaybooksRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { playbookError, type PlaybookStore } from "./PlaybookStore.ts";
import { makeWorkspacePlaybooks } from "./WorkspacePlaybooks.ts";

/**
 * The library is the server's: changing it, or reading which folders it draws on, is an Owner's
 * (People and access); `settings:write` is a permission only an Owner's level holds.
 */
export const PLAYBOOK_RPC_SCOPES = {
  [J5_PLAYBOOK_WS_METHODS.savePlaybook]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.setFolders]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.readSources]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.readLibrary]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.listRuns]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: AuthSettingsWriteScope,
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: AuthSettingsWriteScope,
} as const;

const failedSave = (error: PlaybookError) =>
  error.code === "operation_failed"
    ? failed("The playbook library operation failed.")(error)
    : Effect.fail(error);

const failed = (message: string) => (cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(playbookError("operation_failed", message))),
  );

/**
 * Share the server's store revision through the authenticated WebSocket connection; read runs;
 * and read, export, delete and rename definitions in the workspace a request names.
 */
export const makePlaybookRpcHandlers = Effect.fn("makePlaybookRpcHandlers")(function* (options: {
  readonly store: Pick<
    PlaybookStore["Service"],
    "changes" | "listForThread" | "listAll" | "saveDefinition" | "setFolders" | "sources"
  > &
    Parameters<typeof makeWorkspacePlaybooks>[0];
}) {
  const { store } = options;
  const workspace = yield* makeWorkspacePlaybooks(store);
  return {
    [J5_PLAYBOOK_WS_METHODS.savePlaybook]: (input: PlaybookSaveRequest) =>
      store.saveDefinition(input).pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.setFolders]: (input: PlaybookFoldersInput) =>
      store.setFolders(input).pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.readSources]: () => store.sources().pipe(Effect.catch(failedSave)),
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
