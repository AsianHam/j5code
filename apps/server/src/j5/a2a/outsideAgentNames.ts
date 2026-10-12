import type * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "./contracts.ts";

/**
 * An outside agent joins no ledger, so `j5_a2a_outside_agent` is the only record that it exists
 * and of the label its client signed in with. Its first send or spawn writes it. A sign-in's
 * label never changes, so later ones leave it alone.
 */
export const recordOutsideAgentName = (
  sql: SqlClient.SqlClient,
  input: {
    readonly participantId: ParticipantId;
    readonly name: string;
    readonly at: string;
  },
) => sql`
  INSERT INTO j5_a2a_outside_agent (participant_id, name, created_at)
  VALUES (${input.participantId}, ${input.name}, ${input.at})
  ON CONFLICT (participant_id) DO NOTHING
`;

/** The label of each outside agent asked about that this server has a record of. */
export const outsideAgentNameRows = (
  sql: SqlClient.SqlClient,
  participantIds: ReadonlyArray<ParticipantId>,
) => sql<{ readonly participant_id: string; readonly display_name: string }>`
  SELECT participant_id, name AS display_name
  FROM j5_a2a_outside_agent
  WHERE participant_id IN ${sql.in(participantIds)}
`;
