# Spec: self-serve app-access requests via native Raft approval

Status: draft · Owner: Quiver · Depends on: Slock platform (scope approval)

## Problem

An agent-login identity (e.g. an agent triaging a feedback ticket) usually has
no role on a specific Quiver app, so `get-feedback` and the other app-scoped
actions return `403 insufficient_app_role`. Today an org admin has to add the
account by hand in the app's **Access** tab.

We want the agent to **request access** and an admin to **approve it in the
native Raft UI** — the same interaction as approving a *Login with Raft*
request — with **no custom Quiver approval page**.

## Goals / non-goals

- Reuse Raft's existing approval-card UX; do not build an approval flow in
  Quiver.
- The full loop happens inside Raft: request → card → approve → access granted.
- Non-goal: Quiver deciding *which* scopes require approval — that is a Slock
  platform concern.
- Non-goal: granting anything broader than the requested app role (default
  `viewer`).

## Background — how Raft approval works (from `botiverse/slock` source)

Approval is attached to **integration login + scope**, not to an individual
manifest action (`packages/cli/src/commands/integration/invoke.ts`,
`packages/server/src/routes/internalAgentApi.ts`):

1. `raft integration invoke --service quiver --action <a> --scope <s> --target <conv>`
   calls `integrations.login({ service, scopes: [s], target })`.
2. The Slock server decides whether scope `s` requires human approval. If so it
   returns `status: "approval_required"` with
   `approval: { requestId, target, actionCardMessageId }` and posts an action
   card to `target`.
3. An admin/owner commits the card in the UI (identical to a login request).
4. On approval the login + scope is granted, and the action runs **as the
   agent, carrying scope `s`**.

## Design

### Scope

Introduce an approval-gated scope, e.g. `quiver:app-access` (app supplied as an
action parameter) or a fine-grained `quiver:app-access:{appId}`. Requesting it
is what triggers the native approval card.

### Manifest action

Add a Quiver manifest action:

- `request-app-access` → `POST /api/apps/{app_id}/access-grants/self`,
  invoked with `--scope quiver:app-access --target <admin-conversation>` and a
  `role` param (default `viewer`). On a session that carries the **approved**
  scope, Quiver grants the requesting account that role on the app
  (`INSERT INTO app_members …`, idempotent).

Existing read actions (`get-feedback`, `list-feedback`,
`download-feedback-attachment`) are unchanged; they simply start succeeding once
the grant exists.

### Authorization

The grant endpoint authorizes on **the presence of the approved scope in the
session**, not on "caller is an admin". Because the scope is only obtainable
through the approved login, the admin's card commit *is* the authorization gate.
The endpoint records provenance (who approved, when) for the audit log.

### End-to-end loop

1. Agent invokes `get-feedback` → `403 insufficient_app_role` (machine-readable
   descriptor: `required_role`, `manage_url`).
2. Agent invokes `request-app-access --scope quiver:app-access --param app_id=…
   --param role=viewer --target <admin conv>`.
3. Raft returns `approval_required` and posts an approval card to the admin.
4. Admin commits the card in the UI.
5. The session gains the scope → the grant runs → the agent is now `viewer`.
6. Agent retries `get-feedback` → `200`.

### 403 descriptor wiring

Extend the existing `insufficient_app_role` descriptor with a `request_access`
hint — the exact `raft integration invoke … request-app-access …` command and
scope — so an agent learns the next step directly from the error (pairs with the
already-shipped 403 descriptor and its `manage_url`).

## Open questions (Slock platform)

1. Can a **service-defined scope** be gated behind human approval via
   `agentScopesService`, or does each approval-gated scope need explicit
   platform-side registration/config?
2. How does Quiver read the approved scope from the invoking session on the
   grant call (session cookie / claims contract)?
3. Approval-card content: can Quiver influence what the card shows (requesting
   agent, target app, requested role) so the admin has context before
   approving?

## Rollout

- **Phase A (platform, Slock):** register/gate the `quiver:app-access` scope so
  requesting it requires approval and posts a card.
- **Phase B (Quiver):** `request-app-access` action + `access-grants/self`
  endpoint honoring the approved scope; `request_access` hint on the 403
  descriptor; audit provenance.
- **Verify:** an agent with no role → `request-app-access` → admin approves the
  card → grant → `get-feedback` returns `200`.
