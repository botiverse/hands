/** Stable IDs and a transactional outbox keep notifications independent of
 * delivery outages and prevent replays from making another Play submission. */
export function playDeliveryStatement(db: D1Database, appId: string, event: string,
  eventId: string, payload: Record<string, unknown>, now: number,
  guardSql: string, guardArgs: unknown[]) {
  const body = JSON.stringify({ event, event_id: eventId, delivered_at: now,
    app_id: appId, payload });
  return db.prepare(`INSERT INTO webhook_deliveries
    (id,webhook_id,event_type,payload_json,status,attempts,max_attempts,next_attempt_at,created_at,updated_at,external_event_id)
    SELECT lower(hex(randomblob(16))),w.id,?1,json_set(?2,'$.org_id',a.org_id,'$.payload.app',json_object('id',a.id,'slug',a.slug,'name',a.name)),'pending',0,3,?3,?3,?3,?4
    FROM webhooks w JOIN apps a ON a.id=?5 AND a.org_id=w.org_id
    WHERE (w.app_id IS NULL OR w.app_id=a.id) AND w.enabled=1 AND w.archived_at IS NULL
      AND json_valid(w.events_json) AND (w.events_json='[]' OR EXISTS (
        SELECT 1 FROM json_each(w.events_json) WHERE value IN (?1,'*')))
      AND EXISTS (${guardSql})
    ON CONFLICT(webhook_id,external_event_id) WHERE external_event_id IS NOT NULL DO NOTHING`)
    .bind(event, body, now, eventId, appId, ...guardArgs);
}

export function playStateLabel(state: string): string {
  const labels: Record<string, string> = {
    RELEASE_LIFECYCLE_STATE_DRAFT: "草稿",
    RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: "待提交审核",
    RELEASE_LIFECYCLE_STATE_IN_REVIEW: "审核中",
    RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: "审核通过、待发布",
    RELEASE_LIFECYCLE_STATE_NOT_APPROVED: "审核未通过",
    RELEASE_LIFECYCLE_STATE_PUBLISHED: "轨道可用（可能部分开放或暂停）",
  };
  return labels[state] ?? state;
}
