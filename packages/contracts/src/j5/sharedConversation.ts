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
  /** Moves each time `listThreadAuthors` would answer differently for that thread. */
  subscribeThreadAuthorsChanges: "j5.sharedConversation.subscribeThreadAuthorsChanges",
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
   * The platform's note this message carries to the agent, when it carries one, for a client to
   * draw as a notice.
   */
  note: Schema.NullOr(Schema.String),
  /**
   * Exactly the platform's text the stored message begins with: the note, the author's line and
   * any edited-by line, with the line breaks between them and before the person's words. A client
   * strips this from the start of the text it shows and reads nothing of its format.
   */
  storedPrefix: Schema.String,
});
export type MessageAuthor = typeof MessageAuthor.Type;

/** Who answered one of the agent's prompts: a question, an approval or a Crew roster (AC11). */
export const PromptAnswer = Schema.Struct({
  requestId: Schema.String,
  name: Schema.NullOr(Schema.String),
  level: WriterLevel,
  you: Schema.Boolean,
  /**
   * Exactly the platform's text put at the start of each answer to a question, with the space
   * after it: `[Answer from Priya (collaborator)] `. A typed answer begins with it, and so does
   * the first option of an answer of chosen options. `""` when the answer carries none, such as
   * an approval's. A client strips it and reads nothing of its format.
   */
  storedPrefix: Schema.String,
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

export const ThreadAuthorsChange = Schema.Struct({ revision: Schema.Number });
export type ThreadAuthorsChange = typeof ThreadAuthorsChange.Type;

const SharedConversationError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);

export const J5SharedConversationRpcGroup = RpcGroup.make(
  Rpc.make(J5_SHARED_CONVERSATION_WS_METHODS.listThreadAuthors, {
    payload: ThreadAuthorsRequest,
    success: ThreadAuthors,
    error: SharedConversationError,
  }),
  Rpc.make(J5_SHARED_CONVERSATION_WS_METHODS.subscribeThreadAuthorsChanges, {
    payload: ThreadAuthorsRequest,
    success: ThreadAuthorsChange,
    error: SharedConversationError,
    stream: true,
  }),
);
