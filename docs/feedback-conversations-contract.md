# Reporter-owned feedback conversations

Status: design contract v2 (incremental review candidate)

This contract extends trusted feedback submission into a reporter-owned,
two-way ticket conversation. It deliberately reuses the existing feedback
ticket, comment, attachment, status, audit, webhook, and delivery-retry
infrastructure.

It does not expose the Hands admin application to end users. Integrators render
their own ticket list and conversation UI, authenticate their own users, derive
an opaque reporter identifier, and call Hands from a trusted server.

## Security model

Four values have different jobs:

- The app token authenticates the trusted server integration.
- `reporter_integration_id` identifies the stable integration principal that
  owns reporter identities. It survives credential rotation.
- `X-Hands-Reporter-Id` selects one opaque reporter inside that app. It is not a
  credential and must not contain an email address, username, or internal
  database identifier.
- The ticket id selects a ticket, but never grants access by itself.

Every reporter route requires both an app-scoped custom token bound to an
active reporter integration and a valid `X-Hands-Reporter-Id`. Every ticket,
comment, attachment, idempotency, rate-limit, and audit query is scoped by the
full ownership tuple:

```text
(app_id, reporter_integration_id, reporter_id)
```

An ownership miss returns `404`, not `403`, so the API does not reveal whether
another reporter or integration's ticket exists. Two integrations on the same
app may use the same reporter id without sharing tickets.

`app_reporter_integrations` is a first-class app-owned principal. Creating an
integration returns a stable non-secret id. Deploy credentials reference that
id. Rotating a credential creates a new token that references the same
integration id, so old tickets remain accessible. An unrelated token must
reference a different integration principal and cannot access the first
integration's tickets even if it supplies the same reporter id.

The migration creates one deterministic legacy integration per app that has
existing reporter-owned tickets or role-free `feedback:write` credentials. It
backfills those tickets and credentials to that principal, preserving the
single-integration behavior that existed before this contract. Future
integrations are explicit and may safely coexist.

Trusted ticket submission idempotency is also integration-scoped. The existing
app-wide submission index is replaced by two partial indexes:

- trusted reporter submissions:
  `(app_id, reporter_integration_id, submission_id)` when integration id is
  non-null;
- direct SDK submissions: `(app_id, submission_id)` when integration id is
  null.

Submission lookup, replay, conflict, and reporter comparison use the same
integration dimension. Two integrations may reuse the same submission UUID
without colliding.

Trusted integrations may use one custom token with this feedback-only grant:

```json
{
  "app_role": null,
  "scopes": [
    "feedback:write",
    "feedback:read",
    "feedback:comment",
    "feedback:route"
  ],
  "reporter_integration_id": "integration-uuid"
}
```

The grant must be valid, app-scoped, role-free, bound to an active reporter
integration on the same app, and contain only recognized feedback-proxy scopes
from the allowlist `feedback:write`, `feedback:read`, `feedback:comment`, and
`feedback:route`. T5 trusted submissions require an immutable route binding;
legacy write-only tokens remain valid only for tickets already created before
that gate. Role tokens, role-plus-scope grants, empty or
unknown scopes, and grants containing app read, publish, or admin permissions
are rejected by trusted reporter routes.

The new permissions do not grant access to admin feedback endpoints:

- `feedback:read` reads only tickets owned by the supplied reporter id.
- `feedback:comment` adds only reporter-visible comments to a ticket owned by
  the supplied reporter id.
- Staff list, detail, triage, internal comments, assignee changes, and raw
  metadata remain protected by existing human/app-role rules.

`feedback:read` and `feedback:comment` are token-only capabilities. They are
listed in the atomic permission registry so custom tokens can request them, but
they are not added to any role bundle and have no human-role fallback. Reporter
routes use dedicated bearer middleware; they do not accept a session cookie,
human Login-with-Hands session, development admin token, or generic role
resolver.

The dedicated middleware reads the `Authorization: Bearer` credential and
requires, in one shared helper:

1. credential app id equals the path app id;
2. `app_role` is null;
3. `scopes` is non-empty and grant-valid;
4. every scope belongs to the feedback-proxy allowlist;
5. the current route's required scope is present; and
6. `reporter_integration_id` belongs to the same app and is active.

A valid credential for another app hitting this path returns the existing
scoped-token app-boundary `403`. With the correct app credential, malformed
ticket ids and all ticket/integration/reporter ownership misses return `404`.
Missing or malformed `X-Hands-Reporter-Id` returns `400`. A missing, malformed,
expired, or revoked bearer credential returns `401`; a valid credential with an
invalid grant, missing required scope, inactive integration, or app boundary
violation returns `403`.

The trusted submission guard changes from “the sole effective permission is
`feedback:write`” to “the grant is role-free, integration-bound, feedback-only,
and contains `feedback:write`.” This lets one minimal token submit, read, and
comment. A legacy sole-write credential can submit but cannot read or comment.

## Reporter integration management

Existing app-admin authentication manages integration principals:

```http
GET  /api/apps/{appId}/reporter-integrations
POST /api/apps/{appId}/reporter-integrations
PATCH /api/apps/{appId}/reporter-integrations/{integrationId}
```

Creation accepts a display name and returns a stable id. Archiving an
integration prevents new reporter requests but does not delete tickets. Deploy
token creation accepts `reporter_integration_id`; it is allowed only when
`app_role` is null and all scopes belong to the feedback-proxy allowlist. Token
list/create responses include the non-secret integration id. Rotation reuses
the same principal.

The PATCH body is `{ "archived": true | false }` and requires app admin. An
archive operation is audited and atomically revokes every active credential
bound to the integration. Archived integrations fail closed on all reporter
routes. Unarchiving restores the principal and its ticket ownership but never
unrevokes an old credential; an admin must mint a new credential. Integrations
cannot be physically deleted.

## Reporter API

All routes use an explicit `Authorization: Bearer <app-token>` header and
`X-Hands-Reporter-Id: <opaque-id>`. Cookies and role sessions never satisfy
these routes.

### List tickets

```http
GET /api/apps/{appId}/reporter-feedback?limit=20&cursor=<opaque>
```

The server clamps `limit` to `1..50`. The opaque cursor orders by
`(created_at DESC, id DESC)`. The response contains only reporter-safe fields:

```json
{
  "tickets": [
    {
      "id": "uuid",
      "kind": "feedback",
      "status": "open",
      "message": "...",
      "version_name": "1.2.3",
      "channel": "main",
      "created_at": 0,
      "updated_at": 0,
      "attachment_count": 1,
      "comment_count": 2,
      "latest_comment_at": 0,
      "unread": true,
      "unread_count": 2
    }
  ],
  "next_cursor": "opaque-or-null",
  "unread_total": 1
}
```

`comment_count` counts only non-internal comments. The response excludes
contact data, assignee, client hashes, device identifiers, raw metadata,
symbolication internals, and internal comment counts. `unread_total` counts
owned tickets with at least one unread visible staff/system comment.

### Get ticket conversation

```http
GET /api/apps/{appId}/reporter-feedback/{ticketId}?comment_cursor=<opaque>&comment_limit=50
```

The response contains the same reporter-safe ticket projection, original
attachment metadata, and non-internal comments only. Comment pagination orders
by the immutable database-assigned sequence and clamps the page size to
`1..100`; opaque cursors therefore cannot skip a same-millisecond later insert
whose random UUID sorts earlier. Sequence cursors carry an explicit version.
During a rolling upgrade, a pre-sequence `(created_at, id)` cursor stays in
legacy ordering and emits another legacy cursor until that pagination session
is exhausted; the server never switches ordering mid-session. A successful
detail response advances the ticket's monotonic read receipt only through the
latest visible staff/system comment in that returned page, so a concurrent
reply outside the response snapshot remains unread. The response returns the
updated authoritative `unread_total`.

Comment DTO:

```json
{
  "id": "uuid",
  "author_type": "staff",
  "body": "...",
  "created_at": 0
}
```

`author_type` is one of `reporter`, `staff`, or `system`. The response does not
expose staff account ids, deploy-token names, internal actor strings, or the
reporter id.

### Download an owned attachment

```http
GET /api/apps/{appId}/reporter-feedback/{ticketId}/attachments/{attachmentId}
```

The query verifies app, integration, reporter, ticket, and attachment
ownership before streaming bytes. Reporter queries return only rows whose
`origin IN ('submission', 'reporter')` and `visibility = 'reporter'`. Reporter
origin rows are additionally bound to a visible reporter comment on the same
ticket. Presigned URLs, if
supported, remain short lived (maximum five minutes) and are created only after
the same ownership check. Existing filename sanitization, safe content type,
`Content-Disposition`, and no-sniff response rules remain mandatory.

### Add a reporter comment

```http
POST /api/apps/{appId}/reporter-feedback/{ticketId}/comments
Content-Type: application/json

{
  "body": "Is there an update?",
  "submission_id": "uuid"
}
```

Text-only JSON remains supported. To attach images, send multipart form fields
`body`, `submission_id`, and up to three repeated `attachments`. Attachments are
limited to GIF, JPEG, PNG, or WebP and 10 MiB each.

Comments are plain text. Normalization is exactly ECMAScript `trim()` followed
by UTF-8 encoding; v1 performs no NFC/NFKC Unicode normalization. The normalized
body must be non-empty and is limited to 10,000 Unicode code points.
`submission_id` is required, must be a full UUID, and is normalized to
lowercase. Text-only requests retain the existing SHA-256 fingerprint of the
normalized body bytes. Requests with attachments use a versioned composite of
the body plus each original ordered filename, content type, size, and byte
digest, so changing
filenames, types, sizes, order, or bytes conflicts under the same submission id.

Idempotency is scoped to
`(ticket_id, reporter_integration_id, reporter_id, submission_id)`:

- New comment: `201`.
- Exact replay: `200`, returning the original comment.
- Same id with a different normalized body: `409`.
- Ticket not owned by the reporter: `404`.

Reporter comments and their attachments are always reporter-visible and
non-internal. Reporter status changes remain outside this slice.

Ownership is checked before idempotency conflict handling. An exact replay does
not update the ticket timestamp, write another audit row, create another event,
or enqueue another delivery. Concurrent exact submissions converge to one
comment and return the status multiset `[201, 200]`.

Reporter routes accept only full UUID ticket ids. Malformed ids return `404`;
the admin short-prefix resolver is never reused on this surface.

## Staff mutations and visibility

Existing staff/admin APIs remain the triage surface.

- A non-internal staff comment is reporter-visible and emits a feedback comment
  event.
- An internal staff comment remains staff-only and emits no reporter event.
- A real status transition emits a status event.
- Repeating the current status is a no-op and emits no event.
- Assignee-only changes remain internal and emit no reporter event.

Comment insertion, conditional ticket `updated_at`, audit logging, logical
event insertion, and webhook enqueue must commit atomically in one D1 batch.
Status transition, audit logging, logical event insertion, and webhook enqueue
have the same requirement.

The existing PATCH may include status and assignee in one request. An
assignee-only request updates and audits without a reporter event. When status
and assignee are both present, both mutations, one coherent audit record, the
conditional status event, and delivery enqueue commit in the same D1 batch.
The implementation must not split the request into independently successful
transactions.

## Comment schema

A new append-only migration creates `app_reporter_integrations`, adds
`reporter_integration_id` to deploy credentials and reporter-owned tickets, and
backfills legacy reporter data as described above.

The migration extends `feedback_comments` with:

- `author_type`: `reporter`, `staff`, or `system` (existing rows backfill to
  `staff`).
- `reporter_integration_id`: present only for reporter-authored comments.
- `reporter_id`: present only for reporter-authored comments.
- `submission_id`: present for reporter comment idempotency.
- `submission_fingerprint`: SHA-256 of the normalized comment body.

A partial unique index enforces
`(ticket_id, reporter_integration_id, reporter_id, submission_id)` when all
reporter idempotency fields are present.

Schema checks enforce:

- `author_type = 'reporter'` implies `internal = 0` and integration id,
  reporter id, submission id, and fingerprint are all non-null;
- `author_type IN ('staff', 'system')` implies all reporter ownership and
  idempotency fields are null.

`feedback_attachments` gains explicit `origin` (`submission`, `reporter`,
`staff`, or `system`), `visibility` (`reporter` or `internal`), and nullable
`comment_id` fields. Existing rows
backfill to submission/reporter visibility. Any future staff or system upload
must choose visibility explicitly; reporter DTOs never select staff/internal
rows merely because they share the ticket.

Reporter unread receipts are keyed by the full ownership tuple plus ticket and
store a database-assigned monotonic comment sequence plus the corresponding
comment id. Only visible staff/system comments after that sequence count as
unread; reporter comments and internal comments do not. The sequence is fixed
at insertion, so equal-millisecond replies cannot be lost regardless of random
UUID lexical order. Allocation comes from a declared singleton high-water row
that advances in the same transaction as comment insertion; deletes, cascades,
and SQL export/import cannot compact or reuse earlier sequence values. Hidden
SQLite rowids are used only for the one-time migration backfill, never as the
ongoing allocator.

Before uploading reporter attachments, the Worker records durable leased R2
cleanup intents. Cleanup cannot claim an `uploading` intent until its bounded
15-minute writer lease expires. Reporter attachment insertion requires the
intent to remain `uploading`, and the attachment rows plus intent deletion
commit in one D1 batch; if cleanup claims first, the writer must fail rather
than commit a missing object. Every attempted key is reconciled after upload or
D1 failure. Ambiguous D1 outcomes preserve keys already referenced by committed
attachments, while failed deletes remain `cleanup_claimed` for the scheduled
retry pass.

Comments remain immutable in v1. Deletion/edit history is outside this slice.

The migration also creates a `feedback_events` logical ledger with immutable
event id, event type, app id, ticket id, integration id, canonical payload
bytes, and creation time. `webhook_deliveries.event_id` references this logical
id when present. Legacy deliveries keep a null event id.

## Webhook events

The existing per-org/per-app webhook subscription and retry queue are reused,
but the existing fire-after-mutation helper is not sufficient for this
contract. A durable logical event ledger is added so event bytes and ids are
created once inside the mutation transaction.
Two event types are added:

- `feedback:comment_created`
- `feedback:status_changed`

Every emitted logical event has one stable UUID `event_id`. The delivery ledger
gains nullable `event_id` for legacy compatibility and a partial unique index
on `(webhook_id, event_id)`. Enqueueing the same event for the same webhook is
idempotent. All retries preserve the exact body bytes and event id. Each
subscription still has an independent delivery id.

Common envelope:

```json
{
  "id": "event-uuid",
  "event": "feedback:comment_created",
  "created_at": 0,
  "delivered_at": 0,
  "org_id": "org-id",
  "app_id": "app-id",
  "payload": {}
}
```

Comment payload:

```json
{
  "ticket_id": "ticket-uuid",
  "reporter_integration_id": "integration-uuid",
  "reporter_id": "opaque-id",
  "comment": {
    "id": "comment-uuid",
    "author_type": "staff",
    "body": "...",
    "created_at": 0
  }
}
```

Status payload:

```json
{
  "ticket_id": "ticket-uuid",
  "reporter_integration_id": "integration-uuid",
  "reporter_id": "opaque-id",
  "previous_status": "open",
  "status": "in_progress",
  "updated_at": 0
}
```

Events are not emitted for tickets without a reporter id. Payloads never
include contact data, internal comments, assignees, client hashes, device ids,
raw metadata, or secrets.

More precisely, an event may be generated only when both
`reporter_integration_id` and `reporter_id` are non-null and the integration is
active and belongs to the ticket's app. Any mismatch fails closed without an
event.

Webhook delivery continues to use the existing HMAC-SHA256 body signature and
retry schedule. Additive canonical headers expose the stable logical event id
and the per-subscription delivery id. Consumers must verify the signature and
deduplicate by event id before applying state.

`delivered_at` is retained only as a legacy envelope alias. It is fixed equal
to `created_at` (the logical event/enqueue time) and never changes across
attempts. Actual delivery attempt time is available only from the delivery
ledger (`last_attempt_at`). A retry may update ledger timestamps and counters,
but the signed payload bytes remain byte-identical.

The mutation transaction uses one set-based delivery statement, conceptually:

```sql
INSERT INTO webhook_deliveries (..., event_id, payload_json, ...)
SELECT ..., event.id, event.payload_json, ...
FROM webhooks
JOIN feedback_events AS event ON event.id = ?
WHERE webhooks are active, app/org scoped,
      json_valid(events_json),
      and the event is subscribed
ON CONFLICT(webhook_id, event_id) DO NOTHING;
```

Invalid subscription JSON does not match. The set-based `INSERT ... SELECT`
stays in the same D1 batch and avoids one prepared statement per subscriber.

For a reporter comment, the batch inserts the comment conditionally under the
idempotency unique key, then inserts ticket update, audit, logical event, and
deliveries only by selecting the newly inserted comment id. A concurrent or
exact replay inserts nothing else.

For a staff status mutation, the batch uses the expected previous status and
updates only when it differs from the requested status. Audit/event/delivery
statements select only the successful transition. Same-status retries produce
zero status-event rows; when no assignee value changes, they also produce zero
audit rows. An assignee-only change writes its normal audit row but never
creates a reporter event. A same-status request that really changes assignee is
treated as an assignee-only change. A combined status+assignee request is one
atomic batch as specified above.

## Audit requirements

Hands rate-limits every reporter route by app, integration, hashed reporter,
and endpoint. It also applies an integration-wide safety bucket so a trusted
server cannot evade limits by generating reporter ids:

- list: 60/minute per reporter, 600/minute per integration;
- detail: 120/minute per reporter, 1,200/minute per integration;
- attachment download: 120/hour per reporter, 1,200/hour per integration;
- comment: 30/hour per reporter, 300/hour per integration.

Limits return `429` with a dynamic `Retry-After`. Rate-window rows are retained
for 24 hours and then reaped.

Hands records:

- reporter list/detail access as privacy-sensitive read audit events, throttled
  to at most one row per integration + hashed reporter + endpoint per ten-minute
  window;
- every attachment download as an audit event;
- reporter comment creation with ticket id, comment id, and a hashed reporter
  reference;
- staff external comment and status events with the existing structured actor;
- webhook enqueue/delivery through the existing delivery ledger.

Application logs and errors must not contain app tokens, client keys, webhook
secrets, reporter ids, contact values, comment bodies, or attachment bytes.
Reporter read/download audit rows retain integration id, endpoint, ticket or
attachment id where applicable, and a keyed reporter pseudonym only. The
pseudonym is:

```text
HMAC-SHA-256(
  feedback_audit_key,
  "feedback-audit-v1\0" || app_id || "\0" ||
  reporter_integration_id || "\0" || reporter_id
)
```

Audit rows include a non-secret key-version label so the audit secret can
rotate. The current audit key and version are Worker secrets/configuration; if
either is absent, reporter routes fail closed rather than writing an unkeyed or
plaintext identifier. The digest is deterministic only within a key version;
different integration ids produce different digests for the same reporter id.
Logs and responses never expose the source reporter id or audit key. These
reporter-access audit rows are retained for 30 days and reaped by the scheduled
maintenance path.

## Compatibility

- Existing SDK submission without reporter id is unchanged.
- Existing trusted submission using an exact `feedback:write` token is
  unchanged.
- Existing admin feedback list/detail/update/comment routes and CLI commands
  remain compatible.
- Existing webhook event bodies and legacy signature headers remain valid; new
  event/delivery ids and event types are additive.
- Existing comments are treated as staff-authored. Internal comments never
  become reporter-visible.

## Required executable matrix

At minimum, implementation tests cover:

1. reporter list/detail are app-, integration-, and reporter-scoped;
2. same app + two integrations + same reporter id remain isolated: each list
   returns `200` with only that integration's tickets (or an empty array), and
   integration B using integration A's ticket/attachment id for detail,
   comment, or download returns `404`;
3. correct app-B credential querying an app-A ticket through app B returns 404;
   an app-A scoped credential hitting an app-B path returns the fixed scoped
   credential boundary 403;
4. missing/malformed reporter headers return 400; missing/invalid bearer
   credentials return 401; invalid grants/inactive integration/app boundary
   return 403; ownership misses return 404;
5. malformed or prefix ticket ids return 404 and never produce ambiguous 409;
6. list/detail exclude internal comments and private fields;
7. cursors are stable with equal timestamps and reject malformed values;
8. owned submission attachment download succeeds; cross-owner, staff-origin,
   and internal attachment downloads fail;
9. comment normalization/fingerprint is exact and schema checks reject invalid
   author/visibility combinations;
10. comment new/replay/conflict/concurrent convergence returns `[201, 200]` and
   replay has zero timestamp/audit/event side effects;
11. reporter comments cannot set `internal` or mutate status;
12. exact write-only token can still submit but cannot read/comment;
13. integration-bound feedback-only grants work; cookie/human/dev/role/mixed,
    app grants, unknown scopes, inactive integrations, and missing integration
    bindings fail closed;
14. archiving revokes active credentials; unarchiving does not revive them;
15. token rotation on the same integration preserves access; a different
    integration does not;
16. staff external comments emit one event; internal comments emit none;
17. real status changes emit one event; no-op status and assignee-only updates
    emit no reporter event; combined status+assignee commits atomically;
18. comment/status mutation, audit, logical event, and delivery enqueue are
    atomic;
19. set-based subscription enqueue fails closed on invalid JSON and respects
    `(webhook_id,event_id)` uniqueness;
20. retry changes ledger attempt time but preserves byte-identical signed body,
    `delivered_at = created_at`, signature, and event id; duplicate enqueue
    converges;
21. event payloads omit contact/internal/private/secret fields, require a valid
    app-matching integration+reporter tuple, and place the
    authoritative event id inside the signed body;
22. per-reporter and per-integration limits return dynamic Retry-After;
23. list/detail audit is throttled and downloads are always audited; keyed
    reporter HMAC is deterministic within a key version, differs by
    integration, and missing audit key/version fails closed; 24-hour/30-day
    reapers work;
24. existing admin, CLI, SDK, and webhook compatibility tests remain green.
