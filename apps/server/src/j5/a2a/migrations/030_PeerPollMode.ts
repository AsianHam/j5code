import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A peer's link mode: `push` sends both ways, `store` holds messages for a peer that polls (so no
// origin or credential from it), `poll` records a peer this server polls. `origin` and
// `credential` were NOT NULL, so the table is rebuilt. `handed_out_at` is operational: losing it
// costs only a redelivery, which the peer's idempotent receipt by message id absorbs.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_a2a_peer_poll_mode_new (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      link_mode TEXT NOT NULL CHECK (link_mode IN ('push', 'store', 'poll')),
      origin TEXT,
      credential TEXT,
      credential_expires_at TEXT,
      roster_json TEXT,
      roster_hash TEXT,
      roster_received_at TEXT,
      -- Presence, not completion: on the storing server, when an authorized
      -- poll arrived, since a held poll proves the poller is there and the
      -- online window is far wider than the hold; on the poller, when the
      -- answer to its poll began.
      last_polled_at TEXT,
      last_error TEXT,
      peer_protocol_version INTEGER,
      peer_capabilities TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (link_mode = 'store' AND origin IS NULL AND credential IS NULL)
        OR (link_mode <> 'store' AND origin IS NOT NULL AND credential IS NOT NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_peer_poll_mode_new (
      environment_id, label, link_mode, origin, credential, credential_expires_at,
      created_at, updated_at
    )
    SELECT environment_id, label, 'push', origin, credential, credential_expires_at,
      created_at, updated_at
    FROM j5_a2a_peer
  `;
  yield* sql`DROP TABLE j5_a2a_peer`;
  yield* sql`ALTER TABLE j5_a2a_peer_poll_mode_new RENAME TO j5_a2a_peer`;

  // A credential issued for a peer that will poll this server. The session is
  // an ordinary peer session, so this row is what marks it: the first time the
  // holder presents it, at hello or at its first poll, it becomes the peer's
  // `store` record. Nothing is recorded as a peer before that proof.
  yield* sql`
    CREATE TABLE j5_a2a_peer_store_grant (
      session_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      issued_at TEXT NOT NULL
    )
  `;

  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN handed_out_at TEXT`;
  // A poll reads its peer's waiting rows in ledger order.
  yield* sql`
    CREATE INDEX j5_a2a_delivery_peer_waiting_idx
    ON j5_a2a_delivery (receiver_environment_id, sent_seq)
    WHERE receiver_environment_id IS NOT NULL AND status IN ('pending', 'retry_scheduled')
  `;
});
