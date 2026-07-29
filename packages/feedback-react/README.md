# `@botiverse/hands-feedback-react`

Reporter-facing Hands feedback components. The package renders a ticket inbox,
conversation detail, reply composer, and new-feedback form with `elegant` and
`brutal` themes.

```tsx
import {
  FeedbackProvider,
  FeedbackWorkspace,
  type HandsFeedbackTransport,
} from "@botiverse/hands-feedback-react";
import "raft-ui/styles.css";
import "@botiverse/hands-feedback-react/styles.css";

// Implement this in your app. It calls your authenticated same-origin proxy;
// the complete adapter is in the integration guide linked below.
const transport: HandsFeedbackTransport =
  createMyAppFeedbackTransport("/api/feedback");

<FeedbackProvider
  transport={transport}
  theme="brutal"
  // Optional. Without this override the SDK maps browser `zh*` to `zh-CN`
  // and falls back to English. Pass the host app's selected locale when set.
  locale="en"
  onUnreadChanged={({ total }) => setFeedbackBadge(total)}
>
  <FeedbackWorkspace />
</FeedbackProvider>;
```

The workspace owns the reporter interaction state: list filter/scroll/focus
restoration, per-ticket reply drafts, IME-safe Enter handling, attachment
progress/retry/cancel, recoverable cursor pages, and near-bottom conversation
following. Hosts should not duplicate that state machine. They provide only
the reporter-scoped transport, route notifications, and (optionally) an
attachment opener.

All visible copy, closed error copy, dates, and accessibility labels share the
SDK locale. Supported locales are `en` and `zh-CN`; an explicit provider
`locale` takes precedence over browser language detection.

Localization is provider-driven rather than limited to the built-in bundles.
`messages` accepts a typed partial override (missing keys fall back to the
resolved locale), including parameterized validation strings. `formatDate`
and `formatFileSize` let the host apply its own formatting conventions without
rebuilding SDK UI. Browser negotiation selects the first supported entry in
`navigator.languages` order, then falls back to English.

```tsx
<FeedbackProvider
  transport={transport}
  locale={appLocale}
  messages={{
    newFeedback: t("feedback.new"),
    attachmentUnsupported: t("feedback.attachmentUnsupported"), // `{name}`
  }}
  formatDate={(date, { locale }) => appDateFormatter(date, locale)}
  formatFileSize={(bytes, { locale }) => appFileSizeFormatter(bytes, locale)}
>
  <FeedbackWorkspace />
</FeedbackProvider>
```

## Security boundary

- The package has no `appToken`, `clientSecret`, `reporterId`, or arbitrary
  owner prop.
- The host transport binds a short-lived reporter-scoped session.
- Hands is authoritative for tickets and read/unread state. `unreadTotal`
  comes from Hands responses; the component never derives or persists its own
  read cursor.
- A detail request reports and clears unread only after its successful Hands
  response. Failed, aborted, stale, and unmounted reads do not mutate unread.
- Webhooks are optional server-to-server integrations and are not required for
  inbox correctness.

Consumers using Tailwind v4 should include the compiled package as a source if
their build purges library classes:

```css
@source '../node_modules/raft-ui/dist';
@source '../node_modules/@botiverse/hands-feedback-react/dist';
```

For a source-pinned integration before an npm release, install this package's
Hands monorepo subdirectory with pnpm's `path:` git selector, then import the
explicit source exports:

```bash
pnpm add "github:botiverse/hands#<full-commit-sha>&path:packages/feedback-react"
pnpm add react react-dom raft-ui lucide-react
```

```tsx
import {
  FeedbackProvider,
  FeedbackWorkspace,
} from "@botiverse/hands-feedback-react/source";
import "@botiverse/hands-feedback-react/source/styles.css";
```

The host bundler must support TypeScript/TSX dependencies. Published consumers
should use the compiled root exports shown above.

The complete server credential, opaque reporter identity, route binding, proxy,
transport, webhook, and production-checklist walkthrough is in the
[React Feedback Inbox guide](../../docs/public/feedback-react.md).
