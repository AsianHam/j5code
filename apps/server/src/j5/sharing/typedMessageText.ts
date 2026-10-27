import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Upstream surfaces that read a stored message's text get the words its author typed (#612). In a
 * shared conversation the stored text begins with the platform's lines for the agent, and
 * `j5_a2a_message_author.stored_prefix` names exactly that text, so only it is taken off; a message
 * no one is recorded for, or whose text does not begin with it, is read as stored. The agent still
 * reads the stored text. SQL for upstream's queries to call (FORK.md case 86).
 *
 * Search reads every message, so the per-message work is kept to what a shared conversation
 * needs: whether any message carries the lines is asked once a query (SQLite runs an uncorrelated
 * subquery once), so a server with none reads nothing more, and the text is taken off only the
 * rows a search returns.
 */

const ANY_STAMPED = `EXISTS (SELECT 1 FROM j5_a2a_message_author WHERE stored_prefix <> '')`;

// The author record of the message of a row of `row`, which has its `thread_id` and `message_id`,
// when `text`, its stored text, begins with the record's lines. A lookup by primary key.
const stampedAuthor = (row: string, text: string) => `
  FROM j5_a2a_message_author AS j5_author
  WHERE j5_author.thread_id = ${row}.thread_id
    AND j5_author.message_id = ${row}.message_id
    AND j5_author.stored_prefix <> ''
    AND substr(${text}, 1, length(j5_author.stored_prefix)) = j5_author.stored_prefix
`;

const afterPrefix = (text: string) => `substr(${text}, length(j5_author.stored_prefix) + 1)`;

/** `text`, the stored text of the message of each row of `row`, as its author typed it. */
export const typedMessageTextSql = (row: string, text: string) => `
  CASE
    WHEN NOT ${ANY_STAMPED} THEN ${text}
    ELSE IFNULL((SELECT ${afterPrefix(text)} ${stampedAuthor(row, text)}), ${text})
  END
`;

/**
 * Whether each row of `messages`, an alias of `orchestration_v2_projection_messages` whose stored
 * text matches upstream's `LIKE` pattern (escaped with `!`), still matches it as its author typed
 * it. Only a message that carries the lines is read again.
 */
export const typedMessageMatchesSql = (
  sql: SqlClient.SqlClient,
  messages: string,
  pattern: string,
) => {
  const text = `json_extract(${messages}.payload_json, '$.text')`;
  return sql`
    (
      NOT ${sql.literal(ANY_STAMPED)}
      OR NOT EXISTS (
        SELECT 1 ${sql.literal(stampedAuthor(messages, text))}
          AND ${sql.literal(afterPrefix(text))} NOT LIKE ${pattern} ESCAPE '!'
      )
    )
  `;
};
