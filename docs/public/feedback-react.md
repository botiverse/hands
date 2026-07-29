# Embed a feedback inbox in a React app

`@botiverse/hands-feedback-react` provides a reporter-facing ticket inbox,
conversation view, reply composer, attachment handling, unread state, and a
new-feedback form. It is a UI and interaction-state package: your trusted
backend remains responsible for identifying the signed-in user and calling
Hands.

This guide covers the complete integration, from the Hands credential to the
React component.

## Architecture and trust boundary

Use three layers:

1. The browser renders `FeedbackProvider` and `FeedbackWorkspace`.
2. Your same-origin backend authenticates the user and exposes narrow feedback
   endpoints to the browser.
3. That backend calls Hands with the app's reporter-integration token and a
   stable opaque reporter id.

Never put a Hands deploy token, reporter id secret, webhook signing secret, or
reporter session token in browser JavaScript. The React package deliberately
has no prop for those values.

Hands owns ticket data and read receipts. Your app owns the mapping from its
signed-in account to an opaque Hands reporter id. The ownership boundary in
Hands is the exact tuple `(app, reporter integration, reporter id)`.

## Package status and installation

The React package currently lives in the Hands repository and is **not yet
published to npm**. Until the first npm release, pin a full Hands commit and
use the explicit source export. A full commit SHA makes installs reproducible.

```bash
pnpm add "github:botiverse/hands#<full-commit-sha>&path:packages/feedback-react"
pnpm add react react-dom raft-ui lucide-react
```

```tsx
import {
  FeedbackProvider,
  FeedbackWorkspace,
  FeedbackTransportError,
  type HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react/source";
import "raft-ui/styles.css";
import "@botiverse/hands-feedback-react/source/styles.css";
```

The source-pinned path requires a bundler that can compile TypeScript and TSX
dependencies. After the npm package is published, install and import its
compiled root export instead:

```bash
pnpm add @botiverse/hands-feedback-react raft-ui lucide-react
```

```tsx
import {
  FeedbackProvider,
  FeedbackWorkspace,
} from "@botiverse/hands-feedback-react";
import "raft-ui/styles.css";
import "@botiverse/hands-feedback-react/styles.css";
```

If Tailwind v4 removes library classes, include both compiled packages as
sources:

```css
@source '../node_modules/raft-ui/dist';
@source '../node_modules/@botiverse/hands-feedback-react/dist';
```

## One-time Hands setup

You need:

- a Hands app and its app id and slug;
- one active reporter integration;
- one role-free deploy token bound to that integration;
- exactly the feedback permissions your proxy uses.

For the full inbox, conversation, new-ticket, and routed-event flow, grant all
four feedback permissions:

```json
[
  "feedback:write",
  "feedback:read",
  "feedback:comment",
  "feedback:route"
]
```

Do not add an app role or unrelated permission. Reporter-integration tokens are
intentionally feedback-only. Keep this reporter integration dedicated to the
interactive inbox and submit only `feedback` or `bug` tickets under its
reporter coordinates; crash/error ingestion should use a separate integration
or anonymous client flow.

An app admin can create the integration and token through the authenticated
Hands API. In these setup calls, `HANDS_ADMIN_BEARER` is a human or agent admin
session, not the reporter token returned by the second call.

```bash
export HANDS_ORIGIN=https://hands.build
export HANDS_APP_ID="APP_UUID"
export HANDS_ADMIN_BEARER="ADMIN_SESSION_TOKEN"

curl --fail-with-body \
  -H "Authorization: Bearer $HANDS_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-product-feedback"}' \
  "$HANDS_ORIGIN/api/apps/$HANDS_APP_ID/reporter-integrations"
```

Copy the returned integration `id`, then create the role-free token:

```bash
export HANDS_REPORTER_INTEGRATION_ID="REPORTER_INTEGRATION_UUID"

curl --fail-with-body \
  -H "Authorization: Bearer $HANDS_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  --data "$(jq -nc \
    --arg integration "$HANDS_REPORTER_INTEGRATION_ID" \
    '{
      name: "my-product-feedback-server",
      scopes: ["feedback:write", "feedback:read", "feedback:comment", "feedback:route"],
      reporter_integration_id: $integration,
      expires_in_days: 365
    }')" \
  "$HANDS_ORIGIN/api/apps/$HANDS_APP_ID/deploy-tokens"
```

The raw token is returned once. Put it directly in your server-side secret
manager. Do not commit, log, or send it to the browser. Rotate by creating a
replacement, updating your secret manager, verifying it, and then revoking the
old token.

## Derive opaque reporter coordinates

For each authenticated user, derive two app-scoped opaque values on your
backend:

- `reporterId`: 16–200 base64url characters, stable for this app and reporter
  integration;
- `routeSubject`: `rfr_v1_` plus a base64url value, stable and immutable for
  the same coordinate.

Do not send a raw email, username, Raft handle, or database id to Hands. A
domain-separated HMAC lets your backend reproduce the same values without
storing a reverse lookup in Hands:

```ts
import { createHmac } from "node:crypto";

function opaqueHmac(secret: string, domain: string, accountId: string) {
  return createHmac("sha256", secret)
    .update(`${domain}\0${accountId}`, "utf8")
    .digest("base64url");
}

export function handsReporterCoordinates(input: {
  appId: string;
  integrationId: string;
  accountId: string;
}) {
  const secret = process.env.HANDS_REPORTER_ID_SECRET;
  if (!secret) throw new Error("HANDS_REPORTER_ID_SECRET is not configured");
  const scope = `${input.appId}\0${input.integrationId}`;
  return {
    reporterId: opaqueHmac(
      secret,
      `hands-feedback-reporter-v1\0${scope}`,
      input.accountId,
    ),
    routeSubject: `rfr_v1_${opaqueHmac(
      secret,
      `hands-feedback-route-v1\0${scope}`,
      input.accountId,
    )}`,
  };
}
```

Treat the HMAC secret as a credential. Changing it changes every reporter
coordinate, so plan rotation as an identity migration rather than an ordinary
secret replacement.

## Bind the route before the first ticket

Trusted reporter submissions require a route binding. Bind it during feedback
bootstrap before list, detail, or create operations:

```http
PUT /api/apps/:appId/reporter-feedback/route-subject
Authorization: Bearer <reporter-integration token>
X-Hands-Reporter-Id: <opaque reporter id>
Content-Type: application/json

{ "route_subject": "rfr_v1_<opaque base64url value>" }
```

A new binding returns `201` with `changed: true`. Repeating the exact binding
returns `200` with `changed: false`. A different subject for the same
app/integration/reporter tuple returns `409`; stop and investigate instead of
silently replacing it.

The route subject is carried only in the dedicated, signed reporter webhook
flow. It lets your backend route an event without exposing the reporter id or
maintaining user data in the webhook configuration.

## Proxy the Hands reporter API

Every upstream request made by your backend includes:

```http
Authorization: Bearer <reporter-integration token>
X-Hands-Reporter-Id: <opaque reporter id>
```

Proxy these Hands operations behind your own authenticated, same-origin API:

| Browser operation | Hands upstream operation |
|---|---|
| List tickets | `GET /api/apps/:appId/reporter-feedback?limit=20&cursor=...` |
| Read ticket | `GET /api/apps/:appId/reporter-feedback/:ticketId?comment_limit=50&comment_cursor=...` |
| Create ticket | `POST /public/v2/apps/:appSlug/feedback` as multipart, then read the returned ticket id |
| Reply | `POST /api/apps/:appId/reporter-feedback/:ticketId/comments` as JSON or multipart |
| Download attachment | `GET /api/apps/:appId/reporter-feedback/:ticketId/attachments/:attachmentId` |

Generate one UUID `submission_id` for each new ticket draft or reply and keep
it fixed across retries. A new write returns `201`, an exact replay returns
`200`, and reuse with different content returns `409`.

Do not accept a reporter id, integration id, Hands token, or arbitrary upstream
URL from the browser. Derive all authority from the backend's authenticated
session. Validate ticket and attachment UUIDs before constructing upstream
paths, stream attachment bodies without buffering when possible, and preserve
Hands's `Content-Type`, `Content-Disposition`, `Cache-Control`, and
`X-Content-Type-Options` headers.

Hands optionally supports 30-second server-only reporter sessions. They reduce
long-lived-token verification work on repeated read/comment calls, but remain
backend credentials and are disabled by default. A normal integration can call
the reporter endpoints directly with its feedback-only deploy token.

Hands enforces both per-reporter and per-integration safety limits:

| Operation | Per reporter | Per integration |
|---|---:|---:|
| List | 60/minute | 600/minute |
| Detail | 120/minute | 1,200/minute |
| Attachment | 120/hour | 1,200/hour |
| Comment | 30/hour | 300/hour |
| Trusted ticket submission | 100/hour | — |

Forward `429` and `Retry-After` through your proxy. Keep the user's draft and
retry only after that delay; do not loop immediately or change the
`submission_id` to bypass the limit.

## Implement the React transport

The package asks the host for a `HandsFeedbackTransport`. Point that transport
at your same-origin proxy, never directly at Hands.

The following helpers show the boundary. Adapt the endpoint names to your
backend and map its JSON to the exported SDK types.

```tsx
import {
  FeedbackProvider,
  FeedbackTransportError,
  FeedbackWorkspace,
  type HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react/source";

async function readJson(response: Response) {
  if (response.ok) return response.json();
  const code =
    response.status === 400 ? "invalid" :
    response.status === 401 || response.status === 403 ? "unauthorized" :
    response.status === 404 ? "not_found" :
    response.status === 409 ? "conflict" :
    response.status === 429 ? "rate_limited" : "unavailable";
  throw new FeedbackTransportError(code);
}

const transport: HandsFeedbackTransport = {
  async listTickets({ cursor, limit, signal }) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return readJson(await fetch(`/api/feedback/tickets?${query}`, { signal }));
  },

  async getTicket({ ticketId, commentCursor, commentLimit, signal }) {
    const query = new URLSearchParams({
      comment_limit: String(commentLimit),
    });
    if (commentCursor) query.set("comment_cursor", commentCursor);
    return readJson(await fetch(
      `/api/feedback/tickets/${encodeURIComponent(ticketId)}?${query}`,
      { signal },
    ));
  },

  async createTicket({ kind, message, submissionId, attachments, signal }) {
    const form = new FormData();
    form.set("kind", kind);
    form.set("message", message);
    form.set("submission_id", submissionId);
    for (const file of attachments) form.append("attachments", file);
    return readJson(await fetch("/api/feedback/tickets", {
      method: "POST",
      body: form,
      signal,
    }));
  },

  async addComment({ ticketId, body, submissionId, attachments, signal }) {
    const form = new FormData();
    form.set("body", body);
    form.set("submission_id", submissionId);
    for (const file of attachments) form.append("attachments", file);
    return readJson(await fetch(
      `/api/feedback/tickets/${encodeURIComponent(ticketId)}/comments`,
      { method: "POST", body: form, signal },
    ));
  },
};

export function FeedbackPage() {
  return (
    <FeedbackProvider
      transport={transport}
      theme="elegant"
      locale="en"
      onUnreadChanged={({ total }) => updateFeedbackBadge(total)}
    >
      <FeedbackWorkspace />
    </FeedbackProvider>
  );
}
```

Your proxy may return the SDK's camel-case DTO directly. If it forwards Hands
JSON unchanged, map `created_at`, `updated_at`, `attachment_count`,
`comment_count`, `unread_count`, `author_type`, `content_type`, `size_bytes`,
`next_cursor`, `next_comment_cursor`, and `unread_total` to the corresponding
camel-case SDK fields.

The workspace owns list pagination, focus and scroll restoration, reply drafts,
IME-safe Enter handling, attachment progress/retry/cancel, recoverable cursor
pages, and near-bottom conversation following. Do not build a second copy of
that state machine in the host app.

## Localization and theming

Built-in locales are English and Simplified Chinese. An explicit `locale`
wins; otherwise the package maps browser `zh*` languages to `zh-CN` and falls
back to English. Hosts can override individual messages and formatters:

```tsx
<FeedbackProvider
  transport={transport}
  locale={appLocale}
  messages={{
    newFeedback: t("feedback.new"),
    attachmentUnsupported: t("feedback.attachmentUnsupported"),
  }}
  formatDate={(date, { locale }) => appDateFormatter(date, locale)}
  formatFileSize={(bytes, { locale }) => appFileSizeFormatter(bytes, locale)}
>
  <FeedbackWorkspace />
</FeedbackProvider>
```

Themes are `elegant` and `brutal`. All visible copy, error copy, dates, file
sizes, and accessibility labels use the resolved SDK locale.

## Webhooks and unread state

Webhooks are optional for inbox correctness. Hands remains authoritative for
ticket content and unread state; list/detail responses carry `unread_total`,
and a successful detail read advances the Hands receipt only through visible
staff/system replies returned on that page.

Use a dedicated reporter-integration webhook when your backend needs push
notifications. Verify the signature over the exact request bytes, deduplicate
by the stable event id, and route only from the opaque route subject. Retries
reuse the same body, signature, event id, and delivery id.

## Production checklist

- The token has no app role and exactly the required feedback scopes.
- The token, reporter-id HMAC secret, and webhook secret are server-only.
- Route bootstrap returns `201` once and `200` on exact replay.
- A new ticket returns `201`; retrying the same submission returns `200` with
  the same ticket.
- List and detail return only the signed-in reporter's tickets.
- Cross-reporter ticket, comment, and attachment attempts return `404`.
- Reply retries are idempotent; changed content with the same UUID returns
  `409`.
- `429` preserves the draft and respects `Retry-After`.
- Attachment type, count, and size failures preserve the draft.
- No browser response, log, source map, HAR, or error report contains a Hands
  token or server-side reporter coordinate.

For the complete wire contract, limits, and response behavior, see the
[Public API Reference](public-api-reference.md) and the interactive
[/api-docs](/api-docs).
