# Hands Admin Worker

Separately deployed, staff-only observability UI for Hands.

- No Hands D1 or R2 binding. Product data is available only through the main Worker's named `HandsObservability.getOverview()` RPC method.
- Login with Raft is enforced server-side. An encrypted HttpOnly session carries the Raft token, and every sensitive request re-reads userinfo and rechecks the explicit server allowlist. Every authenticated human or Agent from an allowlisted server may view the dashboard.
- The RPC response is a closed aggregate schema: counts, bytes, enums, and timestamps only.
- Every view is written to this Worker's separate audit D1 database.
- Secrets and production identifiers are injected at deploy time, never committed.
