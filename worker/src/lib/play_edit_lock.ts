/**
 * A play_edit_locks row is held only for the life of one request, and that request
 * is bounded in practice: the CLI's fetch (Node) gives up after five minutes
 * without response headers, and once the client is gone the Worker keeps running
 * only for waitUntil's grace period. A row older than this therefore belongs to a request that was cancelled
 * before its `finally` could delete it. Without expiry, one cancelled request
 * blocks every later Play write for the package until someone edits D1 by hand.
 */
export const PLAY_EDIT_LOCK_STALE_MS = 30 * 60 * 1000;

export async function reclaimStalePlayEditLock(db: D1Database, appId: string, packageName: string, now = Date.now()) {
  await db.prepare("DELETE FROM play_edit_locks WHERE app_id = ?1 AND package_name = ?2 AND acquired_at < ?3")
    .bind(appId, packageName, now - PLAY_EDIT_LOCK_STALE_MS).run();
}
