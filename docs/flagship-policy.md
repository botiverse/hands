# Cloudflare Flagship policy

Hands binds one Cloudflare Flagship app to the production Worker as `FLAGS`.
The binding authenticates automatically inside Workers; it requires no API
token in the repository or Worker environment.

The binding is infrastructure only. Adding it does not create a flag and does
not change product behavior.

## Allowed uses

Flagship may control reversible product behavior such as:

- additive UI or workflow features;
- copy or presentation variants;
- gradual product rollouts;
- non-authoritative product experiments.

Every call must provide an explicit safe default. Code and tests must cover a
missing flag, a type mismatch, and an unexpected evaluation failure. Targeting
context must use the minimum required opaque attributes; do not send raw email,
credentials, ticket bodies, crash content, or unrestricted metadata.

## Controls that must remain deploy-reviewed

Do not use Flagship to bypass or weaken:

- authentication, authorization, app/reporter ownership, or credential scope;
- rate limits, audit, idempotency, signature verification, or data isolation;
- secret/key selection or security-sensitive session modes;
- migrations, destructive data operations, release publication, or rollback
  safeguards.

These controls remain in source-controlled Worker configuration or secrets so
changes retain code review, deployment receipts, and rollback history. For
example, `FEEDBACK_REPORTER_SESSION_ENABLED` must not move to Flagship.

## Failure behavior

Cloudflare's typed Flagship methods return the caller-supplied default for
known failures such as a missing flag or type mismatch. Unexpected runtime
failures can still throw, so callers must catch them and preserve the same safe
default. A switch whose fallback could reduce a security guarantee is not a
product flag and must remain deploy-reviewed.
