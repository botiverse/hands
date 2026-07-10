# Agent CLI: feedback & crash triage

A task-focused walkthrough for agents that need to **read and triage feedback
and crash tickets** from the command line. For the broader auth model and
release/share operations, see the [Agent Guide](/docs/agent-guide/); for the
full command surface, the [CLI Reference](/docs/cli-reference/).

## Why the CLI (and not `integration invoke`)

Hands is a **Login-with-Raft HTTP API service**, not a manifest action
service. So `raft integration invoke --service quiver --list-actions`
returns **none** — that is expected, not a misconfiguration. Agents reach
Hands two ways, both using a Bearer token from Raft Agent Login:

- the **`@botiverse/hands-cli`** npm package (what this page covers), or
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
capabilities follow your Hands **org role**; `403` responses name the role
required.

## 2. Run the CLI

No global install needed:

```bash
npm exec --package @botiverse/hands-cli -- hands whoami
```

(Pin a version with `@botiverse/hands-cli@0.3.2` if you want reproducibility.)
Every command below takes `--json` for scripting.

## Triage commands

The first argument is the **app slug** (or id), e.g. `raft-android`.

```bash
# List tickets, newest first (filterable)
hands feedback list raft-android --status open --kind crash
hands feedback list raft-android --kind bug

# Show one ticket: description, device context, attachments, comments.
# Use the full UUID from the submitted ticket response/reference.
hands feedback show raft-android 389d855b-0000-0000-0000-000000000000

# Triage: change status and/or (re)assign
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status in_progress --assignee me
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --status resolved
hands feedback update raft-android 389d855b-0000-0000-0000-000000000000 --assignee none   # unassign

# Leave an internal comment (also where auto-retrace/symbolication land)
hands feedback comment raft-android 389d855b-0000-0000-0000-000000000000 "reproduced on SGT-AL10; fix in progress"
```

Status flow: `open → in_progress → resolved → closed`. Assignee is
independent of status.

## Quick lookup by feedback id

When a user pastes a Hands feedback id, first identify the app slug. For
Raft Android/mobile, that slug is normally `raft-android`.

New Hands feedback responses include the full UUID in both `id` and the
copyable `reference` field, for example:

```text
raft-android · 1.0.4 (1000400) · ticket 389d855b-0000-0000-0000-000000000000
```

Use that UUID directly:

```bash
TICKET_ID=389d855b-0000-0000-0000-000000000000
APP=raft-android

hands feedback show "$APP" "$TICKET_ID"
```

The CLI now prints full UUIDs in human output. You can also pass a **short id
or any unique prefix** — the feedback read/detail/attachment endpoints resolve
it to the full ticket automatically (an ambiguous prefix returns `409`; use a
longer prefix or the full UUID):

```bash
hands feedback show raft-android 389d855b   # 8-char short id works
```

The `show` output is the first place to check for diagnostics: it includes
the user message, version/channel, device context, comments, and all
attachment ids. Crash deobfuscation/symbolication output is appended as an
internal comment when mapping/symbol assets exist.

For scripts, keep the raw JSON:

```bash
hands feedback show "$APP" "$TICKET_ID" --json > ticket.json
```

## Crashes

Crash tickets (`--kind crash`) carry a grouping **signature** (exception
class + top frame). When the build's `mapping.txt` (Java/R8) or
`native-symbols` archive was uploaded, an auto-deobfuscated / symbolicated
stack is appended as an internal comment — visible in `feedback show`. To
aggregate by signature across a fleet, call the API directly:

```bash
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  https://hands.build/api/apps/<appId>/feedback/crash-groups
```

## Attachments (diagnostics zips, logs)

`feedback show` lists each attachment's id, filename, and size. Download one
with the CLI (accepts a slug and a short/prefix ticket id):

```bash
hands feedback download-attachment raft-android 389d855b <attachmentId>
# → Saved 445539 bytes to slock-feedback-....zip   (use -o to choose the path)
```

Hands saves the **raw bytes as-is** — it does not unzip or interpret the
contents. Hands does not define the files inside an app's diagnostics archive;
it stores and serves the attachment, and the producing app owns the log format
and archive layout (how to open a given app's zip is documented in that app's
repo, not here).

The same downloads and ticket detail can also be fetched directly via REST
(the API path uses the app **UUID**, not the slug):

```bash
APP_ID="$(hands apps get "$APP" --json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  "https://hands.build/api/apps/$APP_ID/feedback/$TICKET_ID"                       # ticket detail
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  "https://hands.build/api/apps/$APP_ID/feedback/$TICKET_ID/attachments/<attachmentId>" \
  -o diagnostics.zip                                                                     # raw attachment
```

## Other environment knobs

- `QUIVER_API` — point the CLI at a non-production Worker (defaults to the
  production origin).
- `--json` — machine-readable output on every command, for agents that parse
  results.
