/**
 * Upstream surfaces that read a stored message's text get the words its author typed (#612). In a
 * shared conversation the stored text begins with the platform's lines for the agent, and
 * `j5_a2a_message_author.stored_prefix` names exactly that text, so only it is taken off; a message
 * no one is recorded for, or whose text does not begin with it, is read as stored. The agent still
 * reads the stored text. SQL for upstream's queries to call (FORK.md case 91).
 *
 * Search reads every hit, so the per-message work is kept to what a shared conversation needs:
 * whether any message carries the lines is asked once a query (SQLite runs an uncorrelated
 * subquery once), so a server with none reads nothing more. Upstream's search matches each hit's
 * words again on the text this returns, so a word only in the lines finds nothing.
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
