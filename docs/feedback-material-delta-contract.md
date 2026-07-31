# Feedback material-delta contract

Status: proposed contract for independent review. This document does not
authorize or include a migration, API implementation, merge, backfill, or
deployment.

Source baseline: `9c52baadf9458b6d48e22eb545a46ca758120923`.

The current reporter pagination domain is the post-migration-0059 schema:
`reporter_sequence` is ticket-local, assigned only to `internal = 0` comments,
and protected by the partial unique index
`(ticket_id, reporter_sequence) WHERE internal = 0`. This contract treats that
domain as an immutable external compatibility boundary. Material delta uses a
separate allocator, column, decoder, and cursor discriminator.

## Decision in plain language

An agent that patrols feedback needs an exact answer to one question: “which
tickets materially changed since my last successful patrol?” `updated_at`
cannot answer it. Symbolication and other internal processing produce false
changes, while two real changes to the same ticket in the same millisecond can
collapse behind the same timestamp cursor.

Give every app its own monotonically increasing internal material-change
counter. Store the latest assigned number on each ticket. Creating a ticket,
really changing its status or assignee, or adding any comment assigns that
ticket the app's next number. Symbolication, reads, downloads, views, and exact
no-op replays do not.

The patrol keeps its own last cursor and asks for current ticket snapshots with
a larger number. This is an authenticated admin/agent surface, not a reporter
integration surface. Reporter surfaces never expose the number, its gaps, or
derived activity counts.

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
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  high_water INTEGER NOT NULL
    CHECK (high_water BETWEEN 0 AND 9007199254740991)
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
benefit from the state row. Allocation fails closed at JavaScript's maximum
safe integer rather than emitting a cursor that cannot be decoded exactly.

The allocator is lazy for an app with no tickets: create state at zero, then
advance to one in the same transaction that creates its first ticket. Database
guards must reject a state update other than `old + 1`, a non-zero lazy-state
insert, and deletion while the parent app still exists. App deletion must still
cascade through both tickets and allocator state; a durability guard must not
turn normal app purge into an undeletable row.

The implementation may adapt the managed high-water shape from migration 0054,
but it must not reuse the retired global comment state or derive from any
`reporter_sequence`. Migration 0059 deliberately left some historical internal
comments carrying values from the old global reporter-numbering domain. Using
their `MAX`, `rowid`, or any other foreign-domain value to seed material delta
would import cross-tenant gaps into the new allocator. Backfill values are
generated solely from the set of tickets within each app, using the deterministic
ordering defined below.

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

The migration backfills every existing ticket before installing runtime
guards. Afterward:

- application request bodies never accept `material_sequence`;
- new-ticket, material status/assignee, and comment triggers are the only
  ordinary writers;
- a ticket sequence update must be strictly greater than its previous value and
  equal the allocator's current high-water for the same app;
- `app_id` cannot change as a side effect of sequence allocation;
- every committed ticket has a positive, non-null sequence.

These guards do not claim to defend against a database administrator who
deliberately reproduces the allocator protocol. They prevent route drift,
accidental direct writes, regression, cross-app assignment, and a ticket value
that runs ahead of or behind its allocator.

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

The schema, rather than only the new Worker, must classify these writes. This
keeps the migration-before-code window and a Worker-only rollback correct:

- `AFTER INSERT` on `feedback_tickets` allocates once for ticket creation;
- `AFTER UPDATE OF status, assignee` allocates once only when either stored
  value changes; changing both in the existing single CAS is one mutation;
- `AFTER INSERT` on `feedback_comments` allocates once for every comment,
  including `internal = 1` and every author type.

The comment trigger is intentionally independent of migration 0059's reporter
trigger. One inserted visible comment advances both domains for their different
audiences; neither high-water is copied from, compared with, or derived from the
other. An internal comment advances material delta and leaves
`reporter_sequence` NULL.

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

Idempotent reporter-comment replay does not insert a second comment and must
therefore produce zero material delta. A conflicting replay, failed attachment
batch, or any transaction that rolls back after allocation must leave both the
ticket sequence and allocator high-water unchanged.

If a future feature adds ticket hard deletion, this snapshot-only contract must
first gain an explicit tombstone carrier. A deleted row cannot be represented
by the current ticket-column design, so hard deletion must not be silently
classified as supported material delta.

## Read contract

Add this route before the existing `feedback/:ticketId` route so the literal is
not interpreted as a ticket id:

```text
GET /api/apps/:appId/feedback/material-delta?cursor=<opaque>&limit=<1..200>
```

It uses the existing admin router and `requireAppRole("viewer")`. Reporter
integration tokens with `feedback:read` are a different principal and must not
reach it. Version 1 has no status, owner, kind, SLA, or updated-time filters;
adding a filter later requires a new query-shape/cursor version or an explicit
binding in the authenticated cursor.

The database query has this logical shape and fetches `limit + 1` rows:

```sql
SELECT <existing admin ticket-list snapshot fields>, material_sequence
FROM feedback_tickets
WHERE app_id = ? AND material_sequence > ?
ORDER BY material_sequence ASC
LIMIT ?;
```

The response is:

```json
{
  "tickets": [],
  "next_cursor": "...",
  "has_more": false
}
```

`tickets` reuses the existing authenticated admin list snapshot and does not
expose `material_sequence` as a standalone field. The handler uses it only to
order the page and create `next_cursor`. `has_more` comes from the extra row;
that row is not returned or acknowledged. An empty page preserves the input
checkpoint rather than advancing to the allocator's current high-water.

The only accepted cursor payload is exactly
`["material-v1", app_id, material_sequence]`, encoded behind the existing
cursor helper. The app id must equal the path parameter and the sequence must be
a JavaScript-safe, non-negative integer. A cursor for another app, an unsafe
integer, a malformed/extra-field payload, a reporter `sequence-v1`, a reserved
reporter `sequence-v2`, or a legacy `(created_at,id)` cursor returns
`400 invalid cursor`; none is silently reinterpreted or reset to zero.
“Opaque” is an API abstraction, not a claim of encryption: authorization and
non-exposure to reporter surfaces are the security boundary.

The API returns:

- current ticket snapshots only;
- ascending material order;
- a versioned next cursor bound to the app and query shape;
- no consumer-specific server-side checkpoint.

The cursor represents the greatest sequence actually returned by that page. A
ticket can appear again after it changes again while a consumer is paging;
consumers must upsert snapshots by ticket id. Duplication is permitted,
omission is not. A consumer advances its durable checkpoint only after it has
successfully processed the whole page, and continues while `has_more` is true.
Continuous writes may extend pagination; no endpoint can promise termination
while the app remains perpetually busy.

The first version does not return a field-level `last_delta`. Consumers already
hold an older snapshot and can diff it locally. Persisting consumer progress or
reconstructable field diffs in Hands would create additional truth sources.

An initial query from cursor zero is also the bootstrap path; it must return all
backfilled tickets for that app in sequence order.

## Isolation contract

`material_sequence`, the admin/agent cursor, cursor gaps, and all values derived
from them are app-internal metadata. They may be documented in the authenticated
admin/agent action surface, but not in the separate reporter API contract.

They must not appear in:

- reporter ticket list or detail DTOs;
- reporter comment pagination cursors;
- reporter-visible events;
- signed reporter webhooks;
- attachment responses;
- reporter OpenAPI schemas or reporter action manifests;
- error messages, response headers, analytics identifiers, or logs returned to
  a reporter.

This is stronger than hiding one column. Because internal comments advance the
counter, any reversible reporter value derived from it leaks the existence and
frequency of staff-only activity. Per-app allocation limits the blast radius
if this boundary ever regresses, but it does not make such disclosure allowed.

The new allocator must not advance, renumber, or otherwise influence the
existing `reporter_sequence` domain. Its decoder accepts only `material-v1`;
the reporter decoder accepts neither `material-v1` nor any value produced by
the material endpoint.

Cross-app cursor replay fails before the query. Even a viewer who is authorized
for two apps cannot use one app's cursor as a numeric oracle for the other.
Per-app allocation limits the impact of accidental disclosure, but does not
make disclosure to a reporter acceptable.

## Threat model and failure posture

Relevant actors are: an unauthenticated caller; a reporter integration token;
an app viewer with legitimate admin read access; a viewer of two different
apps; and an ordinary Worker route accidentally writing or serializing the new
field. Database administrators are trusted to mutate storage but their actions
remain subject to operational audit; the schema cannot protect against an
administrator intentionally emulating the allocator protocol.

The protected assets are staff-only activity existence/frequency, another
app's material volume, exact consumer checkpoints, and completeness of the
agent's delta feed. The primary threats are reporter-surface leakage, cross-app
cursor replay, cursor confusion with reporter pagination, attacker-supplied or
unsafe sequence values, importing another numbering domain during migration,
and a missing production write-path hook that silently omits a material change.

The system fails closed on invalid cursors and allocator invariant violations.
It does not reset an invalid cursor to zero, return a partial cross-app result,
or acknowledge a sequence it did not return. A query/read failure leaves the
consumer checkpoint unchanged. A write failure rolls back state and ticket
together. Per-app allocation is defense in depth for accidental leakage; it is
not authorization to disclose the value.

Availability is bounded with an indexed app-scoped query and a hard page limit.
The endpoint does not offer arbitrary filters or unbounded history expansion.
Allocator exhaustion at the maximum safe integer is a terminal operator error
and aborts the material mutation rather than silently losing numeric precision.

## Migration and rollout contract

The migration must:

1. add the nullable carrier column, then deterministically assign every existing
   ticket a positive per-app sequence ordered by `(created_at, id)`;
2. generate those values solely from `feedback_tickets` membership/order —
   never from `reporter_sequence`, comment ids, comment `rowid`, `updated_at`,
   or another allocator domain;
3. create one allocator row per app with tickets and set `high_water` to the
   exact maximum assigned ticket value;
4. install the exact unique `(app_id, material_sequence)` query index;
5. install lazy-state, `old + 1`, managed-ticket, creation, real
   status/assignee, and all-comment triggers only after backfill is complete;
6. leave status, assignee, comments, reporter sequences, reporter events,
   reporter cursors, receipts, and audit rows unchanged;
7. remain compatible with the previous Worker revision throughout the normal
   migration-before-code rollout window and a Worker-only rollback.

Apps without tickets may create allocator state lazily on their first ticket.
Backup and restore must preserve ticket sequences and allocator rows together;
restoring either side alone is invalid. A validation query must prove for every
non-empty app that ticket sequences are non-null, unique, positive, safe
integers, and that `MAX(ticket.material_sequence) = state.high_water`. An app
with no tickets has either no state row or a zero state row; runtime allocation
must normalize it before assigning one.

No production backfill is authorized by this document. The implementation PR
must state the exact compatibility strategy for the temporarily nullable ALTER
state inside the migration and prove old-writer/new-schema, new-writer/new-
schema, and Worker-rollback/new-schema behavior. No committed post-migration
ticket may remain NULL.

## Carrier evidence and required pre-implementation recheck

A pre-implementation local SQLite 3.45 source-shaped fixture measured the
comment insert plus ticket `updated_at` update as its then-current baseline.
These historical numbers explain the carrier choice; they are relative opcode
shapes, not current production latency or cost claims:

| carrier | Insert | Delete | IdxInsert | IdxDelete | delta from baseline |
| --- | ---: | ---: | ---: | ---: | --- |
| baseline | 4 | 3 | 4 | 1 | — |
| ticket column, combined with existing ticket update | 5 | 4 | 5 | 2 | +1 each |
| append-only change row | 6 | 4 | 5 | 1 | +2 / +1 / +1 / +0 |

With 100,000 fixture rows, the ticket carrier used one indexed search on
`(app_id, material_sequence)`. The append carrier used one change-index search
plus a ticket primary-key search per result.

Before implementation, executable RED tests must repeat the opcode and query-
plan comparison against the exact current full schema, including migrations
0058 and 0059. The test must prove that the plan constrains both `app_id = ?`
and `material_sequence > ?`; merely containing the word `SEARCH` is
insufficient. Removing the index, reversing its columns, or querying without
the app predicate must make the plan tooth fail. The implementation report must
separate relative SQLite opcode evidence from production cost claims.

## Acceptance matrix

1. Two apps start independent sequences. Mutations in one never change the
   other's high-water or create a cross-app gap; replaying its cursor against
   the other app returns `400` before querying.
2. Migration backfill derives dense per-app values only from tickets ordered by
   `(created_at,id)`. Injecting `reporter_sequence`, comment `rowid`,
   `updated_at`, or a foreign high-water into the seed makes a RED fail.
3. Ticket creation and every listed comment class each commit exactly one new
   sequence to the affected ticket. A visible comment may advance both the
   material and reporter domains, but neither value is copied or derived from
   the other; an internal comment advances material only.
4. A batch changing both status and assignee is one material mutation and
   assigns one new sequence, matching the existing single CAS/audit operation.
5. Exact status/assignee replay, idempotent reporter-comment replay, lost CAS,
   symbolication-only update, read receipt, attachment read/download, and a
   failed or rolled-back transaction leave both ticket sequence and app
   high-water unchanged.
6. Two material writes in one D1 batch and competing writes to one app receive
   distinct consecutive committed numbers. A duplicate, regression, skipped
   high-water update, unsafe-integer advance, or ticket-ahead-of-state attempt
   aborts rather than becoming queryable.
7. Equal-millisecond and concurrent material changes are not omitted across
   cursor pages. A ticket that changes again may reappear and remains safe to
   upsert; a limit-plus-one row is never accidentally acknowledged.
8. Cursor zero returns every migrated ticket once in deterministic bootstrap
   order. A second query from the returned cursor is empty when nothing changed;
   an empty page does not jump to an unseen allocator high-water.
9. Only exact `material-v1` with the current app and a safe integer is accepted.
   Reporter `sequence-v1`, reserved `sequence-v2`, legacy timestamp cursors,
   cross-app values, malformed payloads, and negative/unsafe integers are all
   `400` with no reset-to-zero fallback.
10. The literal `/feedback/material-delta` route resolves before
    `/feedback/:ticketId`, requires the existing app-viewer admin principal,
    and rejects reporter integration credentials even when they possess
    reporter `feedback:read`.
11. The 100k-ticket query uses the exact `(app_id,material_sequence)` index and
    constrains both predicates without a full scan. Missing, reversed, or
    sequence-only indexes each make the plan tooth fail.
12. Reporter list, detail, comments, pagination, events, webhooks, attachments,
    reporter schemas/manifests, headers, errors, and reporter-visible logs
    contain no material sequence, material cursor, gap, or derived count.
    Injection into any one makes its isolation test fail.
13. The material decoder rejects reporter cursors and the reporter decoder
    rejects `material-v1`; changes in either domain do not alter the other's
    cursor bytes, stored values, ordering, receipts, or high-water behavior.
14. Migration backfill changes no ticket business field, comment, audit row,
    reporter event, reporter sequence, reporter cursor, or reporter read state.
    Old-writer/new-schema, new-writer/new-schema, and Worker-rollback/new-schema
    traffic all preserve material semantics.
15. App deletion cascades tickets and allocator state without a durability
    trigger blocking purge. Individual ticket hard deletion remains unsupported
    until a tombstone carrier is designed and tested.
16. Backup/restore validation rejects missing state for a non-empty app, NULL,
    unsafe, regressed, cross-app, duplicate, ticket-ahead-of-high-water, and
    high-water-ahead-of-maximum state.
17. Removing any material trigger from a real production write entry point
    makes an entry-point test fail. Service-helper-only green tests do not count
    as proof that ticket creation, admin CAS, reporter comments, staff comments,
    and system comments are wired.

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
- any further opacity/signing redesign of the existing reporter comment cursor.

Migration 0059 already changed future reporter numbering to ticket-local,
visible-only allocation while preserving historical cursor values. This
contract neither reopens that design nor claims historical reporter gaps were
erased. Any later cursor opacity/signing work is a separate compatibility and
security domain.
