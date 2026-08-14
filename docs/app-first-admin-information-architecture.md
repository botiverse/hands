# App-first admin information architecture

Status: proposed design; no runtime, schema, authorization, or production change is authorized by this document.

## Decision summary

Hands should make Apps the first-level navigation and daily working context without changing the current security or data boundary.

The intended change is information architecture and request-context propagation:

- The default signed-in landing page lists every App the current Raft principal can already view.
- Desktop and mobile primary navigation no longer require an active Organization.
- App pages derive their scope from `appId`; users do not switch Organization before opening an App.
- Organization remains the ownership, membership, audit, and governance boundary. Raft server-to-Hands Organization alignment remains unchanged.
- Organization is selected explicitly only for Organization operations, including creating an App.
- Existing direct App grants, legacy server grants, additional owner-server grants, deploy tokens, and Organization-derived access keep their current meaning. This design does not rewrite, promote, demote, or delete them.
- Server access is no longer a normal way to grant new App access in the console. Existing rows remain enforced as compatibility data until a separately reviewed retirement plan exists.

In short: remove Organization from the user's primary navigation context, not from the authorization model.

## Why change the current UI

The current console asks a user to choose an Organization before it can answer the more common question: “Which App do I want to work on?” This creates three problems:

1. A user who can access Apps through more than one Organization or server grant must understand Hands' ownership model before finding an App.
2. The Organization switcher appears to be a product partition even when the user is performing an App-scoped operation such as viewing releases, builds, shares, or feedback.
3. The browser sends the selected Organization on every API request, including routes that already contain an `appId`. That makes navigation state look like an authorization input and creates avoidable stale-context and cache risks.

The target experience starts with the user's accessible Apps, while ownership appears only when it is relevant.

## Current coupling inventory

This section describes the current implementation rather than the target design.

| Surface | Current behavior | Consequence |
| --- | --- | --- |
| API client | `admin/src/lib/api.ts` reads `hands:active-org-id` and attaches `x-hands-org-id` to every request. | App, Organization, auth, and global requests all inherit mutable browser context. |
| Authentication middleware | `worker/src/middleware/auth.ts` uses that header to select a linked `raft_accounts` row for the same provider subject in the requested Organization. | Removing the header without replacing linked-account resolution can change which direct or server-derived grants are visible to authorization. |
| App list | `GET /api/apps` is guarded by `requireCurrentOrgRole("viewer")`. `handleListApps` returns Apps owned by the active Organization plus Apps granted to the selected account's server. | It is not an account-wide accessible-App list and it does not enumerate cross-Organization direct App grants. |
| App routes | `/api/apps/:appId/**` are generally guarded by `requireAppRole(...)`, which derives the App's owning Organization and combines Organization, direct App, server, and deploy-token access. | The URL already has sufficient resource scope, but effective identity resolution can still be affected by the globally selected account row. |
| App creation | `POST /api/apps` uses the implicit current Organization and the creation wizard sends no owner Organization. | Removing active Organization requires an explicit creation scope. |
| Other implicit routes | `/api/parse-apk` also uses `requireCurrentOrgRole`. | Every current-org route must be classified; the header cannot simply disappear globally. |
| Desktop navigation | `admin/src/App.tsx` renders `OrgSwitcher` as the first rail control, then an App switcher. | Organization is presented as the primary mental model. |
| Mobile navigation | The mobile top bar independently renders the same Organization-first pattern. | A desktop-only change would leave the old model on mobile. |
| Cache invalidation | `useClearOrgCache` clears the complete TanStack Query cache when switching Organization. | Correctness currently depends on a global context transition rather than resource-scoped query keys. |
| Apps cards | Cross-Organization Apps are labelled `other org` and expose a technical `org_id` in a tooltip. | Ownership is shown as an implementation detail instead of human-readable secondary context. |
| App Access | `AppAccess.tsx` presents owning server, legacy server grants, additional owner servers, direct members, deploy tokens, and invites together. | The UI continues to teach server-level access as the normal sharing model. |

One important detail is that a Raft principal can have multiple `raft_accounts` rows, keyed by `(provider, provider_subject, server_id)`. `handleListOrgs` already treats rows with the same provider subject and principal type as one linked principal for Organization discovery. App-first navigation must preserve the access that principal could already reach by switching Organization; it must not accidentally evaluate only the session's original account row.

## Security and data invariants

The implementation is acceptable only if all of these remain true.

1. **Ownership remains unchanged.** Every App retains its existing `apps.org_id`. No Organization is merged, split, recreated, or detached from its Raft server.
2. **Organization isolation remains unchanged.** Organization membership, roles, settings, invites, webhooks, and audit logs remain scoped to an explicit Organization and guarded by `ensureOrgRole` / `requireOrgRole`.
3. **App authorization remains unchanged.** An App action is allowed only when the same existing Organization role, direct App role, compatible server grant, or deploy token would allow it today.
4. **Enumeration and enforcement share one definition.** For a human or Agent principal `P`, the account-wide list is exactly:

   ```text
   accessibleApps(P) = { app A | canViewApp(P, A) }
   ```

   The list must not disclose an App that the corresponding `GET /api/apps/:appId` would reject, and it must not omit an App that the principal can already view after selecting one of their linked Organization contexts.

   Set equality is necessary but not sufficient: multi-linked-account fixtures must also contain a positive expected-access assertion. If a direct or server grant belongs to a linked account different from the session row, that specific App must be present in the account-wide list and its detail route must succeed. A test where both sides omit the App is not a passing authorization result.
5. **Linked identity is resolved deliberately.** Account-wide enumeration and App-route enforcement must consider the same set of linked account rows for `(provider, provider_subject, principal_type)`. A stale or absent `x-hands-org-id` must not select a weaker or stronger identity by accident.
6. **No silent grant conversion.** Existing `legacy_role` and `owner_server` rows retain their exact behavior. Direct App members and deploy tokens are untouched. No compatibility row is converted merely because the UI stops advertising it.
7. **No client-side authorization.** Hiding the Organization switcher or Server access UI never replaces Worker-side checks. Direct calls to every endpoint remain guarded.
8. **No wider metadata response.** The account-wide list returns only App-card fields already appropriate for an App viewer. It does not expose Organization membership, server membership, grant rows, private audit data, or account lists.
9. **Deploy-token boundaries remain App-scoped.** A deploy token never becomes an account-wide principal. Existing token behavior stays limited to its bound App and permissions.
10. **Audit attribution remains stable.** App mutations continue to record the real actor and App/Organization association; removing a browser header must not erase or substitute audit scope.

The central implementation requirement is a shared effective-access resolver, not two similar SQL queries. It may expose a set-based query for listing and a single-App check for route guards, but both must be generated from the same access-source and role rules. Copying the rules into `handleListApps` would allow them to drift.

## Target information architecture

### Primary navigation

- `/apps` is the signed-in home and shows all accessible Apps across the principal's linked contexts.
- The desktop sidebar and mobile top navigation show Apps first and do not render an Organization switcher.
- When inside an App, the header shows the App name and App sections such as Overview, Builds, Releases, Shares, Feedback, Settings, and Access.
- Switching Apps does not mutate an Organization value in local storage and does not clear unrelated cached data.

### Secondary ownership and governance

- An App card or App Settings may show a human-readable ownership label such as `Managed by Botiverse` when useful. Technical Organization or server IDs are not primary UI copy.
- Organization Settings is reachable from a secondary account/settings area, not from the primary App navigation.
- Organization pages keep their explicit `/orgs/:orgId/**` URLs and current authorization rules.
- Creating an App is the main flow that requires an Organization choice. If the principal can create in one Organization, it can be preselected and shown for confirmation. If there are several, the creation dialog requires an explicit selection.
- Deep links to `/apps/:appId/**` work directly without first visiting `/apps` or choosing an Organization.

### App Access

The normal App Access page should prioritize:

- direct human or Agent App members;
- invitations that produce explicit App membership;
- App-scoped deploy tokens and integrations.

The current `Server access` add/update experience should not remain a normal invitation path. However, hiding an active permission source completely would make access hard to explain and revoke. During compatibility rollout:

- do not offer creation or role changes for server grants in the normal UI;
- show existing server-derived access only in a collapsed `Inherited access (legacy)` or advanced diagnostic section;
- preserve a guarded remove/revoke action for an App admin;
- label the source in plain language, without presenting technical IDs as the main identifier;
- continue enforcing all existing rows in the Worker.

Whether server grants are eventually converted or deleted is intentionally deferred. That change would alter authorization data and needs its own migration, audit, product acceptance, rollback, and security review.

## Request-context contract

The target API contract makes resource scope explicit.

| Route class | Examples | Target context | Authorization rule | `x-hands-org-id` |
| --- | --- | --- | --- | --- |
| Principal-wide read | `GET /api/apps`, `GET /api/orgs`, `GET /api/auth/me` | Authenticated principal and all linked account rows | Return only resources the principal can already view | Ignored / not sent |
| App-scoped | `/api/apps/:appId/**` | `appId` in path | Shared effective App authorization; App resolves its owner Organization | Ignored / not sent |
| Organization-scoped | `/api/orgs/:orgId/**` | `orgId` in path | Existing explicit Organization role check | Ignored / not sent |
| Create App | Proposed `POST /api/orgs/:orgId/apps` | Explicit owner `orgId` | Existing create minimum on that Organization | Ignored / not sent |
| App-less Organization operation | Current `/api/parse-apk`, if it still needs an Organization boundary | Move under an explicit Organization or App path, or document a distinct global policy | Explicit route guard, never ambient local storage | Ignored / not sent |
| Deploy-token App call | `/api/apps/:appId/**` | Token-bound App plus path `appId` | Existing token App and permission checks | Ignored / not sent |
| Hands admin | `/api/admin/**` | Dedicated Hands-admin policy | Existing `requireHandsAdmin` policy | Ignored / not sent |
| Public | update checks, history, share, download | Public route parameters/token | Existing public contract | Never sent |

`POST /api/orgs/:orgId/apps` is preferred over adding an owner Organization only in a request body because the path makes the authorization boundary auditable and matches existing Organization routes. The current `POST /api/apps` can remain temporarily as a compatibility endpoint requiring an explicit, authorized legacy context; new UI and clients must use the explicit route.

The generic browser `request()` function must stop attaching `x-hands-org-id`. If a temporary compatibility client still needs the old endpoint, it should use a narrowly named legacy helper rather than a global interceptor. No app-scoped call should carry ambient Organization state.

## Account-wide App discovery

The new App list is not the current `handleListApps` query with its Organization filter removed. It is a read-only authorization projection.

For a signed-in human or Agent, it must take the union of the existing viewer-capable sources across all linked account rows:

1. Apps owned by an Organization where a linked account has sufficient Organization membership.
2. Apps with a direct `app_members` grant for any linked account.
3. Apps with a compatible `legacy_role` server grant for a linked account's server.
4. Apps with an `owner_server` grant whose linked Organization role satisfies the same viewer rule used by App routes.

Results are deduplicated by App ID. The effective access source may be included only as a coarse, non-sensitive display hint if needed; raw grant rows and server IDs are not part of the list response.

For a deploy token, preserve current token-specific behavior: it can discover only its bound App when its grant permits the operation. It is not expanded through linked-account logic.

The resolver needs explicit tests proving set equality between account-wide discovery and per-App viewer enforcement. A practical test should compute both sides from fixtures and fail if either contains an extra App.

## Cache and client-state model

- Remove `hands:active-org-id` from normal navigation and stop reading it in the generic API client.
- App queries use App-specific keys such as `['app', appId]`, `['releases', appId]`, and `['builds', appId]`.
- Organization queries include the explicit Organization ID, for example `['org-members', orgId]`.
- The account-wide App list uses a principal/session-scoped key and is invalidated after membership or grant mutations that can change visibility.
- Logout clears authentication material and the complete authenticated query cache. A second user in the same browser must never see the first user's cached Apps.
- During rollout, stale `hands:active-org-id` values may remain in browsers but have no effect on app-scoped or principal-wide requests. They can be removed after the rollback window.
- Switching Apps never requires a full cache wipe. Removing the current global wipe must be accompanied by query-key tests so stale data cannot appear under another App.

## Compatibility and rollout

This should be an additive rollout with no destructive migration.

### Phase 0: freeze semantics and inventory

- Record the shared App access sources and role thresholds in one resolver contract.
- Inventory every route that reads `c.get("org_id")` or uses `requireCurrentOrgRole`; classify it as principal-wide, App-scoped, Organization-scoped, or public/admin.
- Add characterization tests for current direct, Organization, `legacy_role`, `owner_server`, linked-account, and deploy-token behavior before refactoring.

### Phase 1: additive Worker APIs

- Add account-wide accessible-App discovery behind a server-side feature flag or separate temporary endpoint.
- Add explicit Organization-scoped App creation.
- Add the shared linked-principal/effective-App resolver and switch App route guards only when equivalence tests are green.
- Keep existing endpoints and `x-hands-org-id` behavior available for the old console during this phase.

### Phase 2: explicit client context

- Change the API client so Organization context is passed only through explicit route parameters.
- Move all App pages to App-detail queries or the account-wide App list rather than relying on the active-Organization list.
- Introduce resource-scoped cache keys and logout clearing before removing the global cache reset.

### Phase 3: App-first UI

- Enable the account-wide Apps landing page.
- Remove the Organization switcher from both desktop and mobile primary navigation.
- Add the one-time Organization picker to App creation.
- Move Organization Settings to secondary settings.
- Replace raw `other org` / ID copy with optional human-readable ownership context.
- Remove server-grant creation/update from normal App Access and retain the compatibility disclosure/revoke surface.

### Phase 4: deprecate ambient context

- Observe authorization denials, list/detail mismatches, and cache issues for at least one normal release cycle.
- Stop new console-originated server grants. Do not delete existing rows.
- Remove the old `POST /api/apps` and ambient header path only after CLI, Agent Login clients, and the console no longer use them.
- Remove the stale local-storage key after the rollback window.

Task #123's deployed `owner_server` model is therefore compatibility behavior, not the direction to extend in the normal UI. This document does not revert its migration or change its runtime enforcement.

## Rollback

Rollback must be a UI/API-routing rollback, not a data rollback.

- Keep the old Organization-first console path behind a temporary feature flag until App-first acceptance passes.
- If account-wide discovery or linked-account enforcement is incorrect, switch the console back to the old list and Organization switcher while leaving additive APIs unused.
- Keep the existing authorization tables and migration `0064` intact.
- Do not bulk-convert grants in either rollout or rollback.
- Preserve the old compatibility endpoint until all clients have moved, so reverting the console does not require a Worker/database rollback.
- Treat any list/detail authorization mismatch as a rollback trigger. A visible-but-forbidden App and a hidden-but-authorized App are both correctness failures.

## Acceptance and test matrix

### Authorization and discovery

| Scenario | Required result |
| --- | --- |
| App owned by Organization A; principal is an A viewer | Listed once; App detail succeeds as viewer. |
| Principal belongs to Organizations A and B through linked account rows | Authorized Apps from both appear together without an Organization switch. |
| Cross-Organization direct App viewer grant | App is listed and opens without ambient Organization context. |
| Cross-Organization legacy server viewer grant | Existing access remains exactly viewer; no promotion. |
| Additional `owner_server` grant | Existing owner-server role mapping remains unchanged; no new grant is created by navigation. |
| No Organization, direct, server, or token access | App is neither listed nor readable by ID. |
| App admin direct grant on a linked account different from the session row | App is listed and admin routes preserve the same existing authority. |
| Same username/display name but different provider subject | No access is combined. |
| Deploy token for App A | Only App A is reachable; App B remains forbidden. |
| Stale or malicious `x-hands-org-id` | It cannot widen, narrow, or redirect an App-scoped authorization decision. |
| Organization B ID on an Organization A-only account | Explicit Organization route fails closed. |
| Account-wide list versus per-App viewer checks | The two result sets are equal for every fixture, and multi-linked fixtures positively assert that each expected linked-row grant appears and opens. |

### Creation and governance

| Scenario | Required result |
| --- | --- |
| Principal can create in one Organization | Owner Organization is shown/confirmed and bound explicitly. |
| Principal can create in several Organizations | Selection is required; no stale default silently chooses one. |
| Principal submits an unauthorized Organization ID | Worker rejects the request; no App or partial seed data is created. |
| Organization settings deep link | Existing Organization role gates and audit behavior remain unchanged. |
| Existing server grant | Still enforced and visible in the compatibility disclosure; removable only by an authorized App admin. |

### Navigation, mobile, and cache

| Scenario | Required result |
| --- | --- |
| Desktop login | Lands on all accessible Apps; no Organization switcher. |
| Mobile login | Same semantics and reachable controls as desktop; no hidden Organization-first path. |
| Direct App deep link from another Organization | Loads without a preliminary switch or reload. |
| Switch App A to App B | App-scoped cached releases/builds/members never appear under the other App. |
| Grant or revoke App visibility | Account-wide list invalidates and converges to the new authorized set. |
| Logout, then another user logs in | No prior principal's App or Organization data is rendered from cache. |
| Rollback flag enabled | Old Organization-first navigation works with unchanged backend data. |

### Observability teeth

- Count and sample list/detail mismatches without logging private App metadata.
- Track 403 rates for App routes by route class and access-source category, not raw identity.
- Track use of the compatibility `x-hands-org-id`, old App creation endpoint, and server-grant mutation endpoints so retirement is evidence-based.
- Audit server-grant removal and explicit App creation exactly as today.

## Deliberately deferred decisions

This design does not decide:

- whether Hands Organizations should ever stop mapping one-to-one to Raft servers;
- whether existing server grants should be converted into direct membership;
- whether `owner_server` should eventually be deleted from the data model;
- whether Organization billing or broader team concepts should change;
- whether technical Organization IDs should be removed from all APIs;
- whether the compatibility endpoint names should be versioned before removal.

Each would change data or authorization semantics and requires a separate proposal.

## Review gate for implementation

Before runtime work starts, product, owner, and security review should agree on:

1. the route classification table;
2. the linked-principal definition;
3. the single source of truth for App discovery and authorization;
4. compatibility behavior for `legacy_role` and `owner_server` rows;
5. the explicit App-creation scope;
6. the rollout and rollback flags;
7. the full desktop/mobile and permission test matrix.

Only after those points are frozen should implementation be split into backend resolver/API, client context/cache, and navigation/access UI changes.
