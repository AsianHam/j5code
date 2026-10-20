# People and sharing

Several people can use one server. Sharing is done from the web and desktop apps; the mobile app
does not share, leave or rename. Each person has a name, a level at the server, a project or a
thread, and the devices paired as them.

- **Viewer** reads what they were given and changes nothing.
- **Collaborator** writes to its agents, answers their prompts, steers and stops them, and uses
  terminals, files and git there. They do not configure the server, share it, or archive or delete
  threads.
- **Owner**, for the whole server only, also configures and shares it. A server can have several.

Anyone who can write to an agent can have it do anything it can do on the server's machine. Share
writing only with people you trust.

## Sharing

An Owner shares a thread from its menu, its header or its details panel, and a project or the whole
server from **Settings → People → Share…**. The Share dialog lists who already reaches the thing.
Change or remove a level there; a level held through a wider scope is changed at that scope.

To bring someone in, make a link. **Add a person** makes a link for one person and one device, at
any level. Typing the name of someone already on the server gives them the level directly, with no
link; if they already reach the thing at that level, the link pairs one more device as them. **Anyone with the link** makes a link many people can open, as Viewers. A link lasts an hour,
a day, seven days or thirty days. Copy a link again, or revoke it, from the dialog or from People
until it expires or is used. Revoking it stops new people joining and removes no one.

The link opens on the server itself, by an address the server is already reachable at. Whoever
opens it confirms or types their name.

To add your own phone or laptop, type your own name under **Add a person** and open the link on that
device.

## Pairing a device from the terminal

On the server's machine, `j5 pair` makes a link for a named person:

```bash
j5 pair --person "<name>"
```

A name already on the server makes a link that pairs one more device as that person, at their
level. A name nobody has adds that person, and then needs `--level viewer`, `collaborator` or
`owner`; add `--project <id>` or `--thread <id>` to give them a project or a thread rather than the
whole server. Owner is for the whole server only. The command says which it did. Add `--tailscale`
to pair through your tailnet, as for any pairing link.

`--scope` narrows what the device may do, within the person's level. Without it, the device holds
what the person's level allows.

`j5 auth pairing create` without `--person` makes a link for a device the server does not know yet.
Whoever opens it is asked who they are before they can use anything.

## People

**Settings → People** lists everyone on a server you own, with their levels and devices, and the
links in force. Use the picker to choose among your servers. Revoke a device paired with the wrong
link, then pair it again with the right one.

On a server you do not own, People shows only you. Rename yourself there, or with **Change your
name** in the command palette, and leave a project or the server you hold. Leave a thread from its
menu.

## When a device is asked your name

A server asks "What should people and agents on <server> call you?" before a device it cannot place
uses it, and before the first owner's first device does. Pick yourself from the list, or name
someone new.

## What changes for people who are not Owners

Settings shows only Appearance, SnapShots, Open-source licenses and People to someone who owns no
connected server. A device reconnects once when its person's level changes. A phone running the mobile app is
paired again by hand instead, with a new link from an Owner, even when the level was raised. Someone who has lost everything they were given sees "Nothing is shared with you" until an
Owner shares something again.
