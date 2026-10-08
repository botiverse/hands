/** Notifications from verified Apple operation readbacks, not Apple callbacks. */
export function testflightOperationEvent(kind: string, result: Record<string, unknown>) {
  if (result.ok !== true || typeof result.asc_app_id !== "string") return null;
  if (kind === "testflight-upload") {
    const state = result.state as { state?: unknown } | null;
    if (state?.state !== "PROCESSING" || typeof result.build_upload_id !== "string") return null;
    return { event: "testflight:upload_processing", state: "PROCESSING",
      resource: { type: "buildUploads", id: result.build_upload_id } };
  }
  if (kind !== "testflight-publish" || result.distribution !== "internal"
      || typeof result.asc_build_id !== "string") return null;
  const detail = result.beta_detail as { internal_build_state?: unknown; auto_notify_enabled?: unknown } | null;
  const groups = result.assigned_groups as Array<{ id: string; name?: string; is_internal: boolean }> | null;
  const requested = result.requested_group_ids as string[] | null;
  if (detail?.internal_build_state !== "IN_BETA_TESTING" || !Array.isArray(groups)
      || !Array.isArray(requested) || requested.length === 0
      || !requested.every(id => groups.some(g => g.id === id && g.is_internal === true))) return null;
  const selectedGroups = groups.filter(g => requested.includes(g.id));
  return { event: "testflight:internal_distribution_ready", state: "IN_BETA_TESTING",
    resource: { type: "builds", id: result.asc_build_id },
    groups: selectedGroups,
    groups_display: `测试组：${selectedGroups.map(g => g.name?.trim() || g.id).join("、")}`,
    auto_notify_enabled: detail.auto_notify_enabled === true };
}

/** The success receipt and subscriber deliveries commit together. Replaying
 * the same operation is harmless; a failed batch leaves neither committed. */
export async function completeTestflightOperation(db: D1Database, appId: string,
  operationId: string, kind: string, result: Record<string, unknown>) {
  const app = await db.prepare("SELECT id, org_id, slug, name FROM apps WHERE id=?1")
    .bind(appId).first<{ id: string; org_id: string; slug: string; name: string }>();
  if (!app) throw new Error("TestFlight operation app not found");
  const event = testflightOperationEvent(kind, result);
  const now = Date.now();
  const output = JSON.stringify(result);
  const statements = [db.prepare(`UPDATE operation_logs SET status='success',progress=100,
    output=?1,completed_at=?2,updated_at=?2 WHERE id=?3 AND app_id=?4 AND kind=?5
    AND (status IN ('pending','in_progress') OR (status='success' AND output=?1))`)
    .bind(output, now, operationId, appId, kind)];
  if (event) {
    const eventId = `hands-operation:${operationId}:${event.event}`;
    const input = await db.prepare("SELECT input FROM operation_logs WHERE id=?1 AND app_id=?2")
      .bind(operationId, appId).first<{ input: string }>();
    const identity = JSON.parse(input?.input ?? "{}") as Record<string, unknown>;
    const body = JSON.stringify({ event: event.event, event_id: eventId, delivered_at: now,
      org_id: app.org_id, app_id: appId, payload: {
        ...event, source: "hands_operation_receipt", operation_id: operationId,
        app: { id: app.id, slug: app.slug, name: app.name }, apple_app_id: result.asc_app_id,
        previous_state: null, occurred_at: new Date(now).toISOString(), platform: "IOS",
        version: result.version ?? identity.version_name ?? null,
        build_number: result.build_number ?? (identity.version_code == null ? null : String(identity.version_code)),
        app_store_connect_url: `https://appstoreconnect.apple.com/apps/${result.asc_app_id}`,
      } });
    statements.push(db.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,status,attempts,max_attempts,next_attempt_at,
       created_at,updated_at,external_event_id)
      SELECT lower(hex(randomblob(16))),w.id,?1,?2,'pending',0,3,?3,?3,?3,?4
      FROM webhooks w JOIN operation_logs o ON o.id=?5 AND o.app_id=?6
      WHERE w.org_id=?7 AND (w.app_id IS NULL OR w.app_id=?6)
        AND w.enabled=1 AND w.archived_at IS NULL
        AND json_valid(w.events_json) AND EXISTS (
          SELECT 1 FROM json_each(w.events_json) WHERE value IN (?1,'*')
          UNION ALL SELECT 1 WHERE w.events_json='[]')
        AND o.kind=?8 AND o.status='success' AND o.output=?9
      ON CONFLICT(webhook_id,external_event_id) WHERE external_event_id IS NOT NULL DO NOTHING`)
      .bind(event.event, body, now, eventId, operationId, appId, app.org_id, kind, output));
  }
  const receipts = await db.batch(statements);
  if (receipts[0]?.meta.changes !== 1) throw new Error("TestFlight operation receipt no longer writable");
  return now;
}
