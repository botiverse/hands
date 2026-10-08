import { playDeliveryStatement } from "./play_notifications";
export type AgcMarketPackage = { id: string; app_id: string; build_id: string; package_name: string;
  state: "uploading" | "processing" | "ready" | "failed"; external_app_id: string | null;
  external_package_id: string | null; error_message: string | null; created_at: number; updated_at: number };
/** Terminal package transitions and their outbox commit together. Provider errors
 * and signed upload URLs never enter notification payloads. */
export async function recordAgcPackageTransition(db: D1Database, old: AgcMarketPackage,
  state: AgcMarketPackage["state"], options: { packageId?: string; observed?: boolean } = {}, now = Date.now()) {
  if (state === old.state) return false;
  const build = await db.prepare("SELECT version_name,version_code FROM builds WHERE id=?1 AND app_id=?2")
    .bind(old.build_id, old.app_id).first<{version_name: string | null; version_code: number | null}>();
  const eventId = `hands-agc-package:${old.id}:${old.state}:${old.updated_at}:${state}`;
  const error = state === "failed" ? "AppGallery package upload or parsing failed; reconcile before retrying" : null;
  const update = db.prepare(`UPDATE agc_market_packages SET state=?1,error_message=?2,updated_at=?3,
    external_package_id=COALESCE(?4,external_package_id) WHERE id=?5 AND app_id=?6 AND state=?7 AND updated_at=?8`)
    .bind(state,error,now,options.packageId ?? null,old.id,old.app_id,old.state,old.updated_at);
  const delivery = playDeliveryStatement(db, old.app_id, "appgallery:package_state_changed", eventId, {
    source: "hands_appgallery_market_package", platform: "OHOS", lane: "market_package",
    package_id: old.id, build_id: old.build_id, version: build?.version_name ?? null,
    build_number: build?.version_code == null ? null : String(build.version_code), previous_state: old.state, state,
    state_label: state === "processing" ? "市场包上传成功、开始解析" : state === "ready" ? "市场包解析成功（未提审）" : "市场包上传或解析失败",
    observation_display: options.observed ? "定时查询观测（不是正式上架审核结果）" : "",
    occurred_at: new Date(now).toISOString(),
  }, now, "SELECT 1 FROM agc_market_packages WHERE app_id=?5 AND id=?6 AND state=?7 AND updated_at=?8", [old.id,state,now]);
  const results = await db.batch([update,delivery]);
  return results[0]?.meta.changes === 1;
}
