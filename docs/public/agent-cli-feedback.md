# Agent CLI: feedback & crash triage

A task-focused walkthrough for agents that need to **read and triage feedback
and crash tickets** from the command line. For the broader auth model and
release/share operations, see the [Agent Guide](/docs/agent-guide/); for the
full command surface, the [CLI Reference](/docs/cli-reference/).

## Why the CLI (and not `integration invoke`)

Quiver is a **Login-with-Raft HTTP API service**, not a manifest action
service. So `raft integration invoke --service quiver --list-actions`
returns **none** — that is expected, not a misconfiguration. Agents reach
Quiver two ways, both using a Bearer token from Raft Agent Login:

- the **`@oranix/quiver-cli`** npm package (what this page covers), or
- direct REST calls to `/api/*` (see the [Agent Guide](/docs/agent-guide/)).

## 1. Get a token

From any Raft-connected machine:

```bash
raft integration login --service quiver
# → prints a one-time "service callback handoff URL"
curl -s "<that URL>"
# → {"ok":true,"token_type":"Bearer","access_token":"…", …}
```

Export it for the CLI (both names work; `QUIVER_AUTH_TOKEN` takes precedence):

```bash
export QUIVER_BEARER_TOKEN=<access_token>
```

The callback code is one-time — re-run the login for a fresh session. Your
capabilities follow your Quiver **org role**; `403` responses name the role
required.

## 2. Run the CLI

No global install needed:

```bash
npm exec --package @oranix/quiver-cli -- quiver whoami
```

(Pin a version with `@oranix/quiver-cli@0.3.1` if you want reproducibility.)
Every command below takes `--json` for scripting.

## Triage commands

The first argument is the **app slug** (or id), e.g. `raft-android`.

```bash
# List tickets, newest first (filterable)
quiver feedback list raft-android --status open --kind crash
quiver feedback list raft-android --kind bug

# Show one ticket: description, device context, attachments, comments.
# The ticket id can be the short 8-char prefix or the full UUID.
quiver feedback show raft-android 389d855b

# Triage: change status and/or (re)assign
quiver feedback update raft-android 389d855b --status in_progress --assignee me
quiver feedback update raft-android 389d855b --status resolved
quiver feedback update raft-android 389d855b --assignee none   # unassign

# Leave an internal comment (also where auto-retrace/symbolication land)
quiver feedback comment raft-android 389d855b "reproduced on SGT-AL10; fix in progress"
```

Status flow: `open → in_progress → resolved → closed`. Assignee is
independent of status.

## Crashes

Crash tickets (`--kind crash`) carry a grouping **signature** (exception
class + top frame). When the build's `mapping.txt` (Java/R8) or
`native-symbols` archive was uploaded, an auto-deobfuscated / symbolicated
stack is appended as an internal comment — visible in `feedback show`. To
aggregate by signature across a fleet, call the API directly:

```bash
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  https://quiver.oranix.io/api/apps/<appId>/feedback/crash-groups
```

## Attachments (diagnostics zips, logs)

`feedback show` lists each attachment's id, filename, and size. Download one
through the authenticated API endpoint (the CLI doesn't wrap this yet):

```bash
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  "https://quiver.oranix.io/api/apps/<appId>/feedback/<ticketId>/attachments/<attachmentId>" \
  -o diagnostics.zip
```

Find `<appId>` with `quiver apps list` (the slug is stable; the id is the
UUID the API paths use).

## Other environment knobs

- `QUIVER_API` — point the CLI at a non-production Worker (defaults to the
  production origin).
- `--json` — machine-readable output on every command, for agents that parse
  results.
