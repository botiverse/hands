# Feedback material-delta contract

Status: proposed contract for independent review. This document does not
authorize or include a migration, API implementation, merge, backfill, or
deployment.

Source baseline: `493a3384011b5894275da3387b86f8c89c409ead`.

## Decision in plain language

An agent that patrols feedback needs an exact answer to one question: “which
tickets materially changed since my last successful patrol?” `updated_at`
cannot answer it. Symbolication and other internal processing produce false
changes, while two real changes to the same ticket in the same millisecond can
collapse behind the same timestamp cursor.

Give every app its own monotonically increasing material-change counter. Store
the latest assigned number on each ticket. Creating a ticket, really changing
its status or assignee, or adding any comment assigns that ticket the app's next
number. Symbolication, reads, downloads, views, and exact no-op replays do not.

The patrol keeps its own last cursor and asks for current ticket snapshots with
a larger number. This is intentionally an internal agent surface. Reporter
surfaces never expose the number, its gaps, or derived activity counts.

## Existing objects remain authoritative

Hands already has:

- `feedback_tickets.status` for the lifecycle;
- `feedback_tickets.assignee` for ownership;
- CAS-protected status/assignee mutation whose SQL requires an `audit_logs`
  row;
- audit actions for comments;
- `feedback_tickets.updated_at` for ordinary presentation ordering.

This change does not add another status, owner, audit log, content fingerprint,
or “reported” flag. The new sequence is only a lossless ticket-level change
cursor. `audit_logs` remains the detailed history; `updated_at` remains a
human-facing timestamp.

## Data contract

### Per-app allocator

Add an internal high-water state keyed by `app_id`:

```sql
feedback_material_sequence_state (
  app_id TEXT PRIMARY KEY,
  high_water INTEGER NOT NULL CHECK (high_water >= 0)
)
```

This is deliberately not a global singleton. Each app receives its own dense,
monotonic sequence. App A's traffic cannot create gaps in App B's sequence, so
an accidental future disclosure cannot reveal cross-app activity volume.

The database, not request input, owns allocation. For one app, every committed
material mutation advances `high_water` by exactly one and assigns that value
to the affected ticket in the same atomic database unit. Failed or rolled-back
mutations expose neither a changed ticket nor a new committed cursor. SQLite/D1
already serializes writes; this contract does not claim a separate concurrency
benefit from the state row.

The implementation may adapt the managed high-water trigger shape from
migration 0054, but it must not reuse
`feedback_comment_sequence_state`. That state owns reporter comment pagination,
while the new state includes internal material activity. Combining the two
audiences would violate the isolation contract through cursor gaps even if no
new DTO field were added.

### Ticket carrier

Add an internally managed `feedback_tickets.material_sequence` and a unique
index whose exact key order is:

```sql
CREATE UNIQUE INDEX ...
ON feedback_tickets(app_id, material_sequence);
```

The `app_id` prefix is mandatory because the query scope is one app. A
sequence-only index may say `SEARCH` in a plan while still walking other apps'
rows and filtering them afterward.

The ticket column is preferred over an append-only change table. A comment
already updates the ticket row's `updated_at`, so assigning the new sequence in
that same update reuses an existing row write. It also bounds storage, naturally
coalesces repeated changes into the current snapshot, and avoids a per-result
join from change row to ticket. It does not preserve intermediate changes;
`audit_logs` owns that responsibility.

### Material mutations

Assign a strictly larger per-app sequence for:

- creation of a new feedback ticket;
- a status change where the stored value really changes;
- an assignee change where the stored value really changes;
- a reporter comment;
- an external staff comment;
- an internal staff comment;
- a system comment.

Internal comments count because they often represent real handling progress
that a patrol must observe. Their content and even the frequency of their
existence remain private under the isolation rules below.

Do not assign a new sequence for:

- symbolication status, stack, or artifact processing;
- exact status/assignee replay;
- reporter read receipts;
- attachment reads or downloads;
- views, counters, or other internal processing;
- a mutation that fails or loses its existing CAS.

If a future feature adds ticket hard deletion, this snapshot-only contract must
first gain an explicit tombstone carrier. A deleted row cannot be represented
by the current ticket-column design, so hard deletion must not be silently
classified as supported material delta.

## Read contract

The internal agent query has this logical shape:

```sql
SELECT <existing internal ticket snapshot fields>, material_sequence
FROM feedback_tickets
WHERE app_id = ? AND material_sequence > ?
ORDER BY material_sequence ASC
LIMIT ?;
```

The API is authenticated as an internal admin/agent capability and returns:

- current ticket snapshots only;
- ascending material order;
- an opaque, versioned next cursor bound to the app and query shape;
- no consumer-specific server-side checkpoint.

The cursor represents the greatest sequence returned by that page. A ticket can
appear again after it changes again while a consumer is paging; consumers must
upsert snapshots by ticket id. Duplication is permitted, omission is not. A
consumer advances its durable checkpoint only after it has successfully
processed the whole response it intends to acknowledge.

The first version does not return a field-level `last_delta`. Consumers already
hold an older snapshot and can diff it locally. Persisting consumer progress or
reconstructable field diffs in Hands would create additional truth sources.

An initial query from cursor zero is also the bootstrap path; it must return all
backfilled tickets for that app in sequence order.

## Isolation contract

`material_sequence`, the internal cursor, cursor gaps, and all values derived
from them are internal-only metadata.

They must not appear in:

- reporter ticket list or detail DTOs;
- reporter comment pagination cursors;
- reporter-visible events;
- signed reporter webhooks;
- attachment responses;
- public OpenAPI schemas or public action manifests;
- error messages, response headers, analytics identifiers, or logs returned to
  a reporter.

This is stronger than hiding one column. Because internal comments advance the
counter, any reversible reporter value derived from it leaks the existence and
frequency of staff-only activity. Per-app allocation limits the blast radius
if this boundary ever regresses, but it does not make such disclosure allowed.

The new allocator must not advance, renumber, or otherwise influence the
existing `reporter_sequence` domain.

## Migration and rollout contract

The migration must:

1. create one allocator state per app that has feedback tickets;
2. deterministically assign every existing ticket a non-null per-app sequence,
   ordered by `(created_at, id)`;
3. set each app's `high_water` to the maximum assigned value;
4. install database ownership/monotonicity guards and the exact
   `(app_id, material_sequence)` index;
5. leave status, assignee, comments, reporter events, reporter cursors, and
   audit rows byte-for-byte or value-for-value unchanged as appropriate;
6. remain compatible with the previous Worker revision throughout the normal
   migration-before-code rollout window.

Apps without tickets may create allocator state lazily on their first ticket.
Backup and restore must preserve ticket sequences and allocator rows together;
restoring either side alone is invalid. A validation query must prove for every
app that ticket sequences are unique, positive, and no greater than that app's
high-water.

No production backfill is authorized by this document. The implementation PR
must state the exact compatibility strategy for nullable/default state during
the rollout window and prove it with old-writer/new-schema tests.

## Carrier evidence and required pre-implementation recheck

A local SQLite 3.45 source-shaped fixture measured the existing comment insert
plus ticket `updated_at` update as the baseline. These are relative opcode
shapes, not production latency or cost claims:

| carrier | Insert | Delete | IdxInsert | IdxDelete | delta from baseline |
| --- | ---: | ---: | ---: | ---: | --- |
| baseline | 4 | 3 | 4 | 1 | — |
| ticket column, combined with existing ticket update | 5 | 4 | 5 | 2 | +1 each |
| append-only change row | 6 | 4 | 5 | 1 | +2 / +1 / +1 / +0 |

With 100,000 fixture rows, the ticket carrier used one indexed search on
`(app_id, material_sequence)`. The append carrier used one change-index search
plus a ticket primary-key search per result.

Before implementation, executable RED tests must repeat the opcode and query-
plan comparison against the exact then-current full schema. The test must prove
that the plan constrains both `app_id = ?` and `material_sequence > ?`; merely
containing the word `SEARCH` is insufficient. Removing or misordering the index
must make the plan test fail.

## Acceptance matrix

1. Two apps start independent sequences; mutations in one never change the
   other's high-water or create gaps in its observed sequence.
2. Ticket creation and every listed comment class each assign exactly one new
   sequence to the affected ticket.
3. A batch changing both status and assignee is one material mutation and
   assigns one new sequence, matching the existing single CAS/audit operation.
4. Exact status/assignee replay, lost CAS, symbolication-only update, read
   receipt, attachment read/download, and failed transaction leave both ticket
   sequence and app high-water unchanged.
5. Equal-millisecond and concurrent material changes are not omitted across
   cursor pages. Repeated snapshots of a ticket remain safe to upsert.
6. Cursor zero returns every migrated ticket once in deterministic bootstrap
   order; a second query from the returned cursor is empty when nothing changed.
7. The 100k-ticket query uses the exact per-app index without a full table scan;
   the RED mutation for a missing or wrong-order index fails.
8. Reporter list, detail, comments, events, webhooks, attachments, schemas,
   headers, and errors contain no material sequence, cursor, gap, or derived
   count. Injection into any one of them makes its isolation test fail.
9. Material mutations do not change existing reporter cursor bytes or the
   `feedback_comment_sequence_state` high-water.
10. Migration backfill changes no ticket business field, comment, audit row,
    reporter event, or reporter read state, and old-writer/new-schema traffic
    remains valid.
11. Backup/restore validation rejects missing, regressed, cross-app, duplicate,
    or ticket-ahead-of-high-water state.

## Explicitly deferred

- new lifecycle states;
- severity and area taxonomies;
- SLA or due dates;
- canonical Raft/GitHub links;
- close-evidence enforcement;
- `needs_report` or another consumer checkpoint in Hands;
- field-level delta history;
- an append-only triage event ledger;
- Notion migration or backfill;
- any redesign of the existing reporter comment cursor.

The last item is a separate compatibility and security domain. It must be
designed under its own task; this contract does not silently change reporter
pagination behavior.
