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
5. Run a new dry run, compare it with the approved desired state and actual store, then commit the remaining changes if authorized. Do not edit other apps' locks.
