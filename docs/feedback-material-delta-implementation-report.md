# Feedback material-delta implementation evidence

This report records executable local SQLite evidence for migration 0060. It is
not a production D1 latency or billing claim. The authoritative tests are:

- `worker/test/feedback_material_delta_migration.test.ts`
- `worker/test/feedback_material_delta_route.test.ts`

## Query plan

The plan fixture applies the complete ordered migration set through 0059,
inserts 100,000 feedback tickets for one app, applies 0060, and runs the exact
material-delta query shape. The accepted plan must contain:

```text
idx_feedback_tickets_app_material_sequence
(app_id=? AND material_sequence>?)
```

It must not contain `USE TEMP B-TREE FOR ORDER BY`. The test drops the index,
recreates it as `(material_sequence, app_id)`, recreates it as
`(material_sequence)`, and removes the app predicate from the query. Each
mutation must fail the accepted-plan predicate before the exact
`(app_id, material_sequence)` index and query are restored.

## Static SQLite write opcode inventory

The opcode fixture uses the complete schema through 0059 as its baseline and
counts `Insert`, `Delete`, `IdxInsert`, `IdxDelete`, and trigger `Program`
opcodes from `EXPLAIN`. Counts include conditional trigger programs compiled by
SQLite; they are a relative static shape, not the number of writes performed by
every runtime execution.

| write shape | carrier | Insert | Delete | IdxInsert | IdxDelete | Program |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ticket creation | 0059 baseline | 1 | 0 | 14 | 0 | 1 |
| ticket creation | 0060 ticket carrier | 4 | 0 | 17 | 1 | 6 |
| status + assignee | 0059 baseline | 1 | 0 | 5 | 1 | 0 |
| status + assignee | 0060 ticket carrier | 3 | 0 | 6 | 2 | 3 |
| comment insert | 0059 baseline | 2 | 0 | 11 | 2 | 4 |
| comment insert | 0060 ticket carrier | 4 | 0 | 12 | 3 | 7 |
| comment insert | synthetic append carrier | 5 | 0 | 13 | 2 | 5 |

For the current comment path, the ticket carrier adds two table `Insert`
opcodes, one `IdxInsert`, and one `IdxDelete` relative to 0059. The synthetic
append carrier adds three table `Insert` opcodes and two `IdxInsert` opcodes,
with no additional `IdxDelete`. This comparison is why 0060 keeps the current
snapshot on the ticket instead of adding a durable change-history row.

## Rollout and restore checks

The full-migration tests prove all of the following:

- a previous Worker insert that omits `material_sequence` commits with a
  non-null allocated value under the new schema;
- a Worker-only rollback remains compatible because allocation is enforced by
  schema triggers rather than new-writer SQL;
- ticket carrier and allocator writes roll back together on a failed batch;
- a reusable validation query at
  `migrations/validation/0060_feedback_material_delta.sql` returns zero rows for
  valid state and returns a blocking violation for missing allocator state,
  null, non-positive, non-integer, unsafe, or duplicate ticket sequences,
  ticket-ahead state, unsafe high-water, and maximum/high-water mismatch;
- the production app-purge handler still cascades tickets, comments, reporter
  integrations, and allocator state, while direct ticket or integration
  deletion is rejected while the parent app exists.

Run the focused evidence with:

```bash
pnpm --filter @botiverse/hands-worker exec vitest run \
  test/feedback_material_delta_migration.test.ts \
  test/feedback_material_delta_route.test.ts
```
