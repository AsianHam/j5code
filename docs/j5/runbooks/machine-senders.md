---
title: "Machine senders — sending A2A messages from scripts with `j5 a2a`"
kind: runbook
---

# Machine senders

How a cron job, a watchdog, or any shell script sends an agent-to-agent message to an agent without an agent session. The behavior is defined in [agent-to-agent communication](../product/a2a/index.md) (machine participants); this page tells an operator what to type.

A machine participant belongs to one project, which never changes, has a server-unique name, sends plain messages only, and never receives. Everything below runs through `j5 a2a`, which talks to the server over HTTP with a bearer token.

## One-time setup, on the server host

1. Find the project id: `j5 a2a list --json | jq -r '.participants[] | select(.kind=="agent") | [.projectId, .projectTitle] | @tsv' | sort -u`. (`list` needs any token with `orchestration:read`; `j5 auth session issue --token-only` mints one.)
2. Register the machine in that project. Names are 1–64 lowercase letters, digits, or hyphens, and unique across the server; the participant id becomes `machine:<name>`.

   ```sh
   j5 a2a participant create --project <project id> --name watchdog
   ```

   Run on the server host this needs no token: it mints and revokes a temporary local admin session. From elsewhere, pass `--token` with an `orchestration:operate` token. Registering the same name in the same project again is a no-op.

3. Mint the machine's token. It carries only the `a2a:send` scope and is bound to the participant by its subject, so it can send as that machine, read the roster, and answer `whoami`, and nothing else on the server accepts it.

   ```sh
   j5 a2a token issue --participant watchdog --ttl 365d --token-only > ~/.config/j5/watchdog.token
   chmod 0600 ~/.config/j5/watchdog.token
   ```

   A mistyped flag fails before the command runs and prints the help text to stdout (see [Exit codes](#exit-codes)), so check the exit status before trusting the file: `… > ~/.config/j5/watchdog.token || exit`. A token file with spaces or more than one line, such as captured help text, makes every verb that sends the token exit 3 `token_malformed`.

   Tokens are sessions in the local auth database: they survive server restarts and appear in Settings → Connections under their label. Revoke one with `j5 auth session revoke <session-id>`; `j5 auth session list` shows the id.

## Sending

```sh
export J5_TOKEN_FILE=~/.config/j5/watchdog.token
j5 a2a send --to obs-sentinel --message "canary 42" --client-request-id "canary-$(date +%s)"
```

- `--to` takes a participant id (`agent:j5:a2a:…`), a thread id, or an unarchived agent's exact display name (case-insensitive). An ambiguous name exits 4 and lists the candidates in `--json` output.
- `--message` takes literal text, `@path` to read a file, or `-` to read stdin. The ceiling is 64 KiB; put anything larger in a file the agent can read and send the path.
- `--client-request-id` is required. Retrying with the same id returns the original receipt and never delivers twice; a new id is a new message.
- The recipient need not be running. Delivery is durable and lands when its turn allows.
- Connection: `--origin` or `J5_ORIGIN` names the server; without either, the CLI uses the running local server recorded under the base directory (`--base-dir` / `J5CODE_HOME`). The token comes from `--token`, `J5_TOKEN`, `--token-file`, or `J5_TOKEN_FILE`.

## Preflight and inspection

- `j5 a2a whoami` proves the token: it prints the machine participant, its project, and the server version. Exit 3 means the token is missing, invalid, not bound to a machine, or the machine is not registered.
- `j5 a2a list` prints one line per participant: kind, participant id, display name, project, liveness (`idle`, `active`, or `errored` with the measured run status), and reachability. `--json` adds the last run's start and end times and the last error, for scripts that gate a wake on the recipient's state.

## Exit codes

Every verb uses the same codes so scripts can branch without parsing text. With `--json`, the single output object carries `ok`, `exit_code`, `error`, and `message`.

| Code | Meaning                                                                          | What to do                                                                                   |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0    | Done                                                                             |                                                                                              |
| 1    | Unexpected failure (a 5xx, an unreadable response), or a flag the parser rejects | Look at the message; a server failure is usually safe to retry, a rejected flag needs fixing |
| 2    | Usage: missing or invalid input                                                  | Fix the command                                                                              |
| 3    | Unauthenticated, wrong token, or malformed token                                 | Check `whoami`; mint or revoke tokens                                                        |
| 4    | Recipient not found, or an ambiguous display name                                | Use `j5 a2a list`; address by id                                                             |
| 5    | Refused by policy (archived, a machine, a person)                                | Choose a recipient that can receive                                                          |
| 6    | Server unreachable within `--timeout-ms` (2 s)                                   | Queue and retry; the server is down or the origin is wrong                                   |

A flag the command does not take, or a flag value that does not parse, is caught before the command runs. That exits 1, not 2, prints the help text to stdout and the error to stderr, and never prints the `--json` object. Capture output only after checking the exit status. An `--origin` that is not an `http://` or `https://` URL exits 2.

Nothing prompts. When stdin is not a terminal the CLI behaves exactly the same; it never waits on a human.

## What is not here yet

A machine participant cannot be archived or renamed through the CLI; revoking its token is the way to retire it, and its ledger history stays readable. A machine cannot open an ask or receive a reply, so a script that needs an answer must read it from a store the agent writes to.
