# Connecting two J5 servers

Peering lets agents on two J5 servers message each other, for example a work VM and your laptop. Agents still address each other by id, and each sees which server the other lives on, by that server's name. You can tell your agents what each server is for, such as "the laptop has Xcode for iOS builds".

Only peer servers you trust. Peering lets the other server see this server's agents and message them, nothing else. Its credential shows up under **Settings → Connections** as _Peer: <name>_.

## Peer two servers

1. Connect this app to both servers with administrator access. Add the second one under **Settings → Connections** with **Add environment** if it isn't there yet, and turn on **Manage access** when you create its pairing link (or use the server's own startup pairing link).
2. In **Settings → Connections → Peer servers**, choose **Add peer** and pick the two servers. Neither has to be the one this app runs.
3. J5 checks which way each server can reach the other and proposes a setup. It says, in plain lines, how messages will travel in each direction, and asks only what it couldn't work out. Confirm it, or choose **Set up differently** to pick the direction and addresses yourself. Use an https address, or one on a private network such as Tailscale.

Both servers need a version of J5 that supports peering. If one doesn't, the dialog names the server to update. Update peered servers together: while one is behind, no message crosses between them, and messages already sent wait until both are up to date.

If no one client can connect to both servers, run `j5 a2a peer` on each server instead; `j5 a2a peer --help` lists the steps.

## A laptop behind an office firewall

When one server can't be reached, for example a laptop behind a firewall that blocks incoming connections, the laptop **polls**. It opens every connection itself: it sends its messages to the other server directly, and the other server stores messages for the laptop until the laptop asks for them. Nothing needs to be opened on the firewall.

While the laptop is awake, stored messages reach it within seconds. While it's asleep or closed, they wait until it's next on, and each agent's messages arrive in the order it sent them. An agent sending to it is told that the laptop is offline and when it was last available.

## A server that isn't always on

If both servers can reach each other but one runs in the desktop app, or was started by hand, J5 asks how messages should get to it:

- **Send them directly** suits a server that is always on with the app open. Messages sent while it's off aren't delivered: they fail after a few quick retries.
- **Store them until it polls** is the default and is safe if you're not sure: messages wait until it's next on.

## Server names

A server's name is its computer name; on Windows, or where the machine has none, it's the hostname. To rename it, rename the machine, then restart J5 on it (quit and reopen the desktop app, or restart the server): on macOS, the computer name in System Settings; on Linux, `hostnamectl set-hostname --pretty "Work VM"`. J5 reads the name when it starts, and the new name reaches the other server the next time one of them polls the other, or the other server reads its address book. If you can't rename a machine, such as a managed work laptop, tell your agents in their instructions, for example "JM-LT-04213 is my work laptop".

## When a server's address changes

If you move a server to a new address, such as a new port or hostname, its peers keep trying the old one, and **Peer servers** shows the error. Open the pair's menu (**⋯**) and choose **Edit**. J5 checks where each server can reach the other, fills in the address it found, and switches only once the server answers there. Nothing waiting is cancelled and the peering itself is unchanged, so there's no need to remove it.

## Checking and removing a peer

**Peer servers** lists every peering among the servers this app manages, one row per pair. Each row shows how messages travel and whether anything is wrong on each side. If it says the other server ended this peering, choose **Remove…** from the pair's menu (**⋯**); to peer them again, use **Add peer**. If it names a server to update, update J5 there.

Removing a peer on a server cancels every message waiting there for the other server and ends every open Exchange with its agents, and each agent on that server that was involved is told. If this app can manage both servers, **Remove** removes the peering on both. If it can't, J5 warns that the other server will keep its side, and its messages to this server's agents will fail until you remove it there too; choose **Remove here only** only if that's what you want. Removing a peer revokes the credential it holds here, so it can no longer deliver to this server. Revoking its _Peer:_ session under **Settings → Connections** also stops its messages, but keeps it listed. Peering again starts empty, and **Add peer** clears any old record the other server still holds. To change how messages travel between two servers, remove the peer on both servers, then peer them again.
