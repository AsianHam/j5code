/**
 * SQL for upstream's queries (FORK.md case 91) to read a stored message as its author typed it:
 * only `j5_a2a_message_author.stored_prefix` is taken off; the agent still reads the stored text.
 * Search asks once per query whether any message carries lines (an uncorrelated subquery), so a
 * server with none pays nothing; upstream re-matches words on the returned text.
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
