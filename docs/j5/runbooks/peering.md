---
title: "Peering — connecting two J5 servers with `j5 a2a peer`"
kind: runbook
---

# Peering

How an operator records two J5 servers as each other's peers so their agents can exchange messages. The behavior is defined in [cross-device](../product/cross-device.md) (Peering); this page tells an operator what to type. The web app's Settings → Connections offers the same steps in one action when a client is connected to both servers; the CLI is for headless hosts and scripts.

Peering is mutual and pairwise, and a pair travels one of two ways. **Sending directly**: each server holds a credential the other issued and the origin it reaches the other at, and delivers to it. **Polling**: one server cannot be reached, such as a laptop behind an office firewall, so it opens every connection itself. The reachable server issues it a credential and stores its messages; the unreachable one records the reachable one, sends to it directly, and polls it for what it stores. Agents address a participant on a peer by the same id as a local one, and see which server it lives on.

## Vocabulary

- **Work** and **Home** below are the two servers. Every step names which host it runs on.
- **Environment id** is a server's stable identity, printed by `j5 a2a peer credential` and shown by the client in Settings → Connections.
- **Origin** is the URL one server reaches the other at. It is not necessarily the URL your laptop uses: a loopback or SSH-forwarded address that works for the client does not work between servers.
- **A server's name** is its own: the label its environment descriptor publishes, from the machine's name. Each peer record carries the other server's current name, refreshed when one of them polls the other or reads the other's address book. To rename a server, rename its machine, then restart J5 on it, which reads its name when it starts: the computer name in System Settings on macOS, `hostnamectl set-hostname --pretty "Work VM"` on Linux. A machine you cannot rename keeps its name; tell your agents what it is in your own instructions ("JM-LT-04213 is my work laptop").

## Peering two servers that send directly

Run each pair of steps on the named host. Every command talks to the local server; run on the server host it needs no token (a temporary local admin session is minted and revoked). From elsewhere, pass `--token` with an `access:write` token.

1. **On Work**, read Work's environment id: `j5 a2a peer identity` prints it (it reads the public environment descriptor and needs no token; Settings → Connections shows the same id). Then **on Home**, issue the credential Work will present when it delivers to Home:

   ```sh
   j5 a2a peer credential --for <work environment id> --label Work --credential-only > work.credential
   ```

   The credential is a session in Home's auth database with subject `peer:<work environment id>` and the single scope `a2a:peer`, valid for ten years so peering never lapses quietly; Home's record of the peer shows when it expires. It appears in Settings → Connections as `Peer: Work`; `--label` only names that session, and the peer record takes Work's own name. Issuing again for the same environment does not revoke the earlier credential yet: the earlier one is revoked when Work proves the new one at Home's hello route (step 2), so a rotation that stops halfway leaves Work able to deliver.

2. **On Work**, record Home, proving the credential at Home's origin:

   ```sh
   j5 a2a peer add --peer-origin https://home.example:3773 --credential-file work.credential
   ```

   Work calls Home's hello route with the credential. It records the peer only if Home answers, the credential names Work, and Home is not Work itself. Home names itself in that answer: the record takes Home's own name, the one its clients show, and refreshes it as **A server's name** above describes, which also says how to rename one. Re-adding a known peer rotates its credential; re-adding it at a different origin is refused unless you pass `--replace-origin`, because hello proves the origin is reachable, not that it is the same server. On a refused move the server tries the new credential at the recorded origin too and keeps it only if that origin accepts it; the error says which happened. If it was not kept and the new address was the same server, re-pair at the recorded origin. To move a known peer without a fresh credential, use `peer move` below.

3. **On Work**, issue Home's credential the same way, and **on Home**, add Work. One Exchange needs both directions, so peering is incomplete until all four steps have run.

## Peering a server that polls

When one server cannot be reached, it polls. Below, **VM** can be reached and **Laptop** cannot. There are two steps, because only Laptop connects.

1. **On VM**, issue Laptop a credential marked for polling:

   ```sh
   j5 a2a peer credential --for <laptop environment id> --label Laptop --store --credential-only > laptop.credential
   ```

   Nothing is recorded on VM yet. VM records Laptop as a peer it stores messages for the first time Laptop presents this credential.

2. **On Laptop**, record VM at its origin, to poll:

   ```sh
   j5 a2a peer add --peer-origin https://vm.example:3773 --credential-file laptop.credential --poll
   ```

   Laptop says hello at VM's origin, which proves VM is reachable and records Laptop on VM. Laptop then polls VM whenever J5 runs on it, picks up what VM stores for it, and sends its own messages to VM directly. A poll pairing is refused before anything is recorded if VM's J5 is too old to store for a poller; update it there.

A pair's mode changes only by removing the peer on both servers and peering again. Issuing `--store` for a peer recorded to send directly, or adding with `--poll` a peer recorded the other way, is refused with that instruction.

## Inspecting and ending peering

- `j5 a2a peer list` prints one line per peer: environment id, the peer's own name, how messages travel (`sends directly both ways, at <origin>`, `this server polls it at <origin>`, or `polls this server for its messages`), recorded at, whether the peer still holds a live session here (`inbound: active` or `inbound: no live session`; omitted for a peer this server polls, which never holds one), when the credential it issued us expires, and for a pair that polls: whether it is online (`online, last polled <time>`, within the last two minutes), `offline since <time>` after that, or `has not polled yet` (`not polled yet` for a peer this server polls); how many messages wait for it and since when; and the last error. A server that polls stops on a rejected credential or a 403/409 refusal, and then prints `polling stopped: <reason>` in place of its health and last error. A rejected credential means the other server removed this one: in either link mode the last error reads `<server> rejected this server's credential (HTTP 401): it ended this peering.`, and `remove` is what is left to do here. A protocol mismatch prints the same, naming the server to update, but is retried once a minute, so polling resumes once that server is updated. A server it cannot reach is retried, backing off to once a minute.
- `j5 a2a peer move --environment <id> --peer-origin <origin>` changes the origin this server reaches a peer at, for a peer it sends to directly or polls. It presents the credential it already holds at the new origin and records the origin only if the same peer answers there; nothing is issued, revoked or cancelled, and a poller polls the new origin at once. A peer that polls this server has no origin here to move: run it on that server. It is refused, with exit code 5, if a different server answers or the credential is refused there, which also happens when the peer has revoked it.
- `j5 a2a peer remove --environment <id>` deletes this server's record of the peer and revokes the session that peer held here, and wipes the slate on this server in every link mode. Every message still waiting to reach the peer is cancelled, whether stored, retrying or alarmed. Its sender gets a not-delivered notice, with three exceptions: for a message the peer may already hold, because a poller picked it up or it was sent directly with no refusal back, the notice says it may not have been delivered; the sender of an ask, or of a message on an Exchange the removal drops, gets that Exchange's drop notice instead; and a sender already told of a refusal gets nothing more. Every open Exchange with an agent on that server is dropped, with the usual drop notice to the agent here, which then owes nothing. The removal is one write transaction: a message from or for the peer that arrives meanwhile is wiped with the rest or, once it commits, refused (the peer's deliveries get `403 peer_not_registered`). Peering again starts empty: nothing cancelled or dropped comes back. Delivery ends in both directions from this server's point of view; run it on the other server too to clean up its side. Removing a peer is also how a pair changes link mode: remove it on both servers, then peer again.
- Revoking the `Peer: …` session in Settings → Connections ends inbound delivery from that peer: its deliveries are refused and alarm on its side, where its record reads that this server ended the peering. This server's own record and outbound delivery are untouched until you `remove` the peer; `peer list` shows the peer as `inbound: no live session` meanwhile.
- Adding a peer from the dialog when the other server still holds an old record of this one, such as one left by a removal made here only, clears that record there first; a client that cannot manage the other server is told which server to clear it on.

## Exit codes

The `peer` verbs use the same codes as the rest of `j5 a2a` ([machine senders](machine-senders.md)). Three are worth knowing here: 6 means the local server or the peer origin could not be reached, or the peer rejected the credential (HTTP 502 `peer_credential_rejected`); 5 means the peer refused the pairing (the credential names another environment, or the peer is already recorded at a different origin); 2 means the request was invalid, including an origin that is this server itself.
