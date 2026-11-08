# Recover an uncertain store-product operation

A `STORE_PRODUCT_LOCKED` or `recovery_required` response means a Hands request may still be executing or a store may have accepted a write whose response was lost. The lock intentionally has no time-based expiry. A dry run is still available for inspection; do not infer from elapsed time that a write finished.

1. Identify the exact `operation_id` from the response or the app's `store_product.attempt` audit entry. Check the caller has stopped and all provider-side requests have finished. Read the relevant product, price schedules, group, and screenshot state in the provider. Record any steps that actually happened. A price change can be irreversible; never replay blindly.
2. If an Apple group-create outcome is uncertain, check the target app's subscription groups. An outstanding `store_apple_group_intents` row prevents duplicate group creation. A later successful read of the intended group clears that intent. If the group is absent, do not clear the intent until the provider confirms the earlier create cannot still complete.
3. If an Apple screenshot is stuck in `AWAITING_UPLOAD`, investigate its reservation and ownership. Do not delete a screenshot another operator may be uploading. Resolve or remove an abandoned reservation in App Store Connect only after that is established.
4. Once the provider state is understood and no prior request can still write, an authorized operator may remove **only** the exact lock identified by its operation id. First read it:

   ```sql
   SELECT provider, target_hash, operation_id, acquired_at
   FROM store_product_locks WHERE operation_id = '<operation-id>';
   ```

   After verifying the row and obtaining the production-write authorization required by your environment, delete the exact observed row using all three fields:

   ```sql
   DELETE FROM store_product_locks
   WHERE provider = '<provider>' AND target_hash = '<target-hash>' AND operation_id = '<operation-id>';
   ```

   Read back the row and confirm it is gone. If a no-longer-possible Apple group creation must be cleared, first read its intent and delete only the exact matching `target_hash`, `group_hash`, and `operation_id`, under the same approval. Do not clear an intent based on age alone.
5. Run a new dry run and compare it with the approved desired state and actual store. Commit remaining changes only if the specific operation is enabled and authorized. Do not edit other apps' locks.

## App Information candidate operations

The public App Information commit endpoint is currently disabled with `APP_INFO_COMMIT_UNVERIFIED`; the following applies only if a future, separately reviewed change enables it. Do not remove the guard or perform a store write as part of recovery.

For an `APP_INFO_LOCKED` or an uncertain result with `recovery_required`, identify the exact app, Apple app ID and operation before acting. Its lock uses provider `apple_app_info` and `target_hash = SHA-256(UTF-8("app-info:" + Apple app ID))`. It is shared across Hands apps resolving to the same Apple app, but cannot prevent changes in App Store Connect or other clients. Never release it just because time elapsed.

1. Inspect the `app_store.app_info.attempt` and `app_store.app_info.result` audit entries by operation ID if they exist. The attempt identifies the selected App Information and planned locale/field changes by hashes and lengths, not the plaintext. A crash between lock acquisition and recording the attempt may leave a lock without an audit entry; absence of an entry is **not** evidence that the request cannot still write. Preserve the response and audit evidence; obtain the original approved request securely when needed.
2. Establish that the caller and all provider requests have finished and cannot still write. With the release owner, inspect the exact pending App Information record and its localizations and primary category in App Store Connect. Compare against the approved intent and any returned per-step statuses. `written` means a response was received, not that every other step succeeded; `unknown` may have been applied; `not_attempted` was not sent by this operation. A failed or unavailable readback cannot prove either outcome. App Information is shared across platforms, so also inspect affected platform submissions. If state or request completion cannot be established, keep the lock and escalate rather than retrying.
3. Once the state is understood, use the exact-row read, separately authorized delete, and readback procedure above. Restrict it to provider `apple_app_info` and the matching target hash and operation ID. Inspect the provider state again and rerun a preview before any separately authorized remaining work. The public endpoint currently cannot commit.
