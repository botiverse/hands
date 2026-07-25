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

const transport: HandsFeedbackTransport = createReporterTransport({
  // Resolve this through your backend. Never ship an app/deploy token to the
  // renderer. The session must be short-lived and scoped to one app+reporter.
  getSession: () => fetch("/api/hands-feedback-session").then((r) => r.json()),
});

<FeedbackProvider
  transport={transport}
  theme="brutal"
  onUnreadChanged={({ total }) => setFeedbackBadge(total)}
>
  <FeedbackWorkspace />
</FeedbackProvider>;
```

## Security boundary

- The package has no `appToken`, `clientSecret`, `reporterId`, or arbitrary
  owner prop.
- The host transport binds a short-lived reporter-scoped session.
- Hands is authoritative for tickets and read/unread state. `unreadTotal`
  comes from Hands responses; the component never derives or persists its own
  read cursor.
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

```tsx
import { FeedbackProvider, FeedbackWorkspace } from "@botiverse/hands-feedback-react/source";
import "@botiverse/hands-feedback-react/source/styles.css";
```

The host bundler must support TypeScript/TSX dependencies. Published consumers
should use the compiled root exports shown above.
