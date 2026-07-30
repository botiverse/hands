# Designing state for agents to consume

Hands is agent-native: an agent is expected to poll for what changed and act on
it without a person in the loop. That changes what an API has to guarantee.

A person can sort by "recently updated", scan the list, and skip what looks
familiar. Approximate is fine, because a human filters the remainder. An agent
cannot. It asks *"what changed since I last looked?"* and acts on the answer, so
**a missed row is a missed action and an extra row is a duplicate action**.

This page describes the pattern Hands uses for its own change feeds. It applies
equally if you are building an integration that mirrors Hands state, or
designing a feed of your own for agents to read.

## 1. Expose an exact cursor, not a timestamp

An agent needs a total order it can resume from: *everything after N*.

A `updated_at` timestamp looks sufficient and is not:

- **Same-millisecond collisions.** Two changes to one record inside the same
  millisecond are indistinguishable, so `updated_at > T` silently drops one.
- **Everything moves it.** Any write touching the record bumps it, including
  internal processing the consumer does not care about.

Use a monotonic sequence assigned by the database, exposed as an opaque cursor.
The consumer stores the last value it saw and asks for the next page after it.

If your platform already has a sequence primitive, reuse it rather than
reinventing monotonicity — getting concurrent assignment, gap behaviour, and
immutability right is more subtle than it looks.

**Measure the write cost before deciding where the sequence lives.** A
trigger-assigned sequence typically turns one insert into an insert plus an
update, and every index containing the sequence column pays a delete and
re-insert each time it advances. Two carriers are worth comparing directly:

| Carrier | Cost | Trade-off |
|---|---|---|
| Column on the existing record | Cheap when that record is already updated by the same operation | Slightly more index maintenance on a hot row |
| Append-only side table | No update to the hot record | An extra row write, a join on read, and unbounded growth needing a retention policy |

Index the cursor with its scope first — `(tenant, sequence)`, not `(sequence)` —
or the scan crosses other tenants' rows and filters them out afterwards.

## 2. Advance only on material change

Write down which events move the sequence, and keep machinery out of it.

| Material | Not material |
|---|---|
| The record is created | Background post-processing |
| A field the consumer reports on changes | No-op writes setting a field to its current value |
| A person adds a comment | The consumer's own read receipts |

If housekeeping advances the cursor, the agent is woken repeatedly by noise from
your own system and re-reports items that did not change — the exact failure the
cursor exists to prevent.

**Unchanged content must produce zero delta.** That is worth a test rather than
a comment, because it is easy to break later without noticing.

## 3. Keep the consumer's progress out of your source of truth

Two things that look convenient and are not:

- **A "needs processing" flag.** It records whether *one particular consumer*
  has acted, which is that consumer's state living in your data. It breaks as
  soon as a second consumer exists.
- **Field-level change history**, so the consumer can be told exactly which
  fields moved. The consumer already holds the previous snapshot and can diff
  locally for the same answer. Storing it creates a second source of truth to
  keep consistent, for no new information.

Return the **current snapshot** of anything past the cursor. The consumer knows
where it was; your system only needs to know what is true now.

## 4. Keep internal-only values out of every externally visible carrier

If a sequence advances on internal-only events — private notes, internal triage
— then **the sequence is itself internal data**, even though it carries no text.

This is easy to miss, because permission checks are usually written against
content. A filter that hides internal comment bodies does not hide a counter,
since the counter is metadata rather than content. But an external reader
watching the number move learns **how often and when internal activity happened**
on a record. No text is disclosed; the existence and frequency of activity is.

The rule therefore covers carriers, not just fields. An internal sequence, the
**gap between two sequence values**, and any count derived from either must stay
out of:

- list and detail responses
- event payloads and webhooks
- **pagination cursors**

That last one is the easiest to overlook. A cursor that is base64-encoded JSON
is readable by anyone holding it — encoding is not concealment. If a cursor must
carry an internal value, sign it and treat it as opaque, or derive the cursor
from a value that is safe to reveal.

Generalise this when reviewing permissions: counters, ETags, `updated_at`,
result totals, and pagination cursors can each carry an inference that the
field-level redaction was written to prevent.

## 5. Scope the sequence per tenant

Prefer one sequence per app or tenant over a single global one.

Functionally they are equivalent, because the query filters by tenant either
way. They differ only when something goes wrong: a global counter that escapes
tells its reader about *every* tenant's activity volume, while a per-tenant
counter that escapes tells one tenant about itself.

The cost is a state row per tenant instead of one, with the same assignment
logic and an index that already leads with the tenant.

## Checklist

For any feed an agent will consume:

- [ ] Monotonic, database-assigned sequence — not a timestamp
- [ ] Material-change definition written down, with a test that unchanged input
      produces zero delta
- [ ] Write cost measured, carrier chosen on that evidence
- [ ] Cursor index leads with the query scope
- [ ] Snapshot returned; no consumer progress stored, nothing stored the
      consumer can derive
- [ ] Internal-only values absent from responses, events, webhooks and cursors,
      enforced by a test that fails if one is added
- [ ] Sequence scoped per tenant
