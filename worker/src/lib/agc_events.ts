import { playDeliveryStatement } from "./play_notifications";

export type AgcSubmission = { id: string; app_id: string; build_id: string; state: string;
  external_app_id: string; external_version_id: string; provider_state_json: string; updated_at: number };
const labels: Record<string, string> = { uploading: "开始上传", processing: "开始解析", ready: "可提交邀请测试",
  failed: "上传或解析失败", testing_review: "开始提审", testing_scheduled: "审核通过、等待测试开始",
  testing_active: "邀请测试已开放", rejected: "邀请测试审核失败", stopped: "邀请测试已停止" };
export function agcStateLabel(state: string) { return labels[state] ?? state; }
/** CAS + nonce guard keeps the state, local history and outbox one transaction.
 * Never serialize provider messages, signed URLs, tester identities or credentials. */
export async function recordAgcTransition(db: D1Database, old: AgcSubmission, state: string,
  detail: Record<string, unknown> = {}, error: string | null = null, now = Date.now()) {
  if (state === old.state) return false;
  const nonce = crypto.randomUUID();
  const previous = JSON.parse(old.provider_state_json || "{}") as Record<string, unknown>;
  const snapshot: Record<string, unknown> = { ...previous, ...detail, notification_nonce: nonce };
  const build = await db.prepare("SELECT version_name,version_code FROM builds WHERE id=?1 AND app_id=?2")
    .bind(old.build_id, old.app_id).first<{ version_name: string | null; version_code: number | null }>();
  const groupIds = Array.isArray(snapshot.group_ids) ? snapshot.group_ids.filter((id): id is string => typeof id === "string") : [];
  const eventId = `hands-agc:${old.id}:${nonce}`;
  const update = db.prepare(`UPDATE market_submissions SET state=?1,provider_state_json=?2,error_message=?3,updated_at=?4
    WHERE id=?5 AND app_id=?6 AND provider='appgallery' AND lane='invitation_test' AND state=?7 AND updated_at=?8`)
    .bind(state, JSON.stringify(snapshot), error, now, old.id, old.app_id, old.state, old.updated_at);
  const guard = `SELECT 1 FROM market_submissions WHERE app_id=?5 AND id=?6
    AND json_extract(provider_state_json,'$.notification_nonce')=?7`;
  const history = db.prepare(`INSERT INTO market_submission_events(id,submission_id,state,detail_json,created_at)
    SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM market_submissions WHERE id=?2 AND app_id=?6
      AND json_extract(provider_state_json,'$.notification_nonce')=?7)`)
    .bind(nonce, old.id, state, JSON.stringify(snapshot), now, old.app_id, nonce);
  const delivery = playDeliveryStatement(db, old.app_id, "appgallery:invitation_state_changed", eventId, {
    source: "hands_appgallery_submission", platform: "OHOS", lane: "invitation_test",
    submission_id: old.id, build_id: old.build_id, version: build?.version_name ?? null,
    build_number: build?.version_code == null ? null : String(build.version_code), previous_state: old.state,
    state, state_label: state === "ready" && snapshot.release_state === 11 ? "开发者撤回邀请测试审核"
      : state === "testing_review" && detail.release_state != null ? "邀请测试审核中" : agcStateLabel(state),
    observation_display: detail.notification_source === "provider_poll" ? "定时查询观测（不是刚发生的审核变化）" : "",
    provider_state: typeof snapshot.release_state === "number" ? snapshot.release_state : null,
    ...(groupIds.length ? { groups_display: `测试组 ID：${groupIds.join("、")}` } : {}),
    occurred_at: new Date(now).toISOString(),
  }, now, guard, [old.id, nonce]);
  const results = await db.batch([update, history, delivery]);
  return results[0]?.meta.changes === 1;
}
