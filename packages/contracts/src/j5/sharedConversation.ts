import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { ThreadId } from "../baseSchemas.ts";
import { J5ActionError } from "./actionError.ts";

/**
 * Who wrote what in a shared conversation, as the people reading it are told
 * (docs/j5/product/features/shared-conversations.md). The agent reads the author's line and the
 * platform's notes in each message's stored text; a client draws them from these records instead
 * and strips them from the text it shows.
 */
export const J5_SHARED_CONVERSATION_WS_METHODS = {
  /** Who sent each message and answered each prompt, for anyone who can read the thread. */
  listThreadAuthors: "j5.sharedConversation.listThreadAuthors",
} as const;

/** The level a writer had when they wrote, as the author's line names it. */
export const WriterLevel = Schema.Literals(["owner", "collaborator"]);
export type WriterLevel = typeof WriterLevel.Type;

/**
 * Who sent one message: the name and level they had when they sent it (AC47). A message with no
 * entry was not sent by a person while the thread was shared.
 */
export const MessageAuthor = Schema.Struct({
  messageId: Schema.String,
  name: Schema.NullOr(Schema.String),
  level: WriterLevel,
  /** Someone else edited it while it was queued; the author's line stays the author's. */
  editedBy: Schema.NullOr(Schema.String),
  /** The person asking wrote it. */
  you: Schema.Boolean,
  /**
   * The platform's note this message carries to the agent, when it carries one: the stored text
   * of the message begins with exactly this, then a line break, then the author's line.
   */
  note: Schema.NullOr(Schema.String),
});
export type MessageAuthor = typeof MessageAuthor.Type;

/** Who answered one of the agent's prompts: a question, an approval or a Crew roster (AC11). */
export const PromptAnswer = Schema.Struct({
  requestId: Schema.String,
  name: Schema.NullOr(Schema.String),
  level: WriterLevel,
  you: Schema.Boolean,
});
export type PromptAnswer = typeof PromptAnswer.Type;

export const ThreadAuthorsRequest = Schema.Struct({ threadId: ThreadId });
export type ThreadAuthorsRequest = typeof ThreadAuthorsRequest.Type;

export const ThreadAuthors = Schema.Struct({
  /** More than one person has been able to write to the thread (AC6). */
  shared: Schema.Boolean,
  authors: Schema.Array(MessageAuthor),
  answers: Schema.Array(PromptAnswer),
});
export type ThreadAuthors = typeof ThreadAuthors.Type;

export const J5SharedConversationRpcGroup = RpcGroup.make(
  Rpc.make(J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors, {
    payload: ThreadAuthorsRequest,
    success: ThreadAuthors,
    error: Schema.Union([J5ActionError, EnvironmentAuthorizationError]),
  }),
);
