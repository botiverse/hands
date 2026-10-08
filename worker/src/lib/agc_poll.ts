import { recordAgcPackageTransition, type AgcMarketPackage } from "./agc_package_events";
import { getAgcCompileStatus, AGC_PACKAGE_OK, AGC_PACKAGE_FAILED, getAgcTestVersionStatus, mapAgcTestReleaseState } from "./agc_api";
import { recordAgcTransition, type AgcSubmission } from "./agc_events";
import { resolveAgcAppAuth } from "../routes/agc_testing";
import { enqueueDueDeliveries } from "../routes/webhooks";
/** Bounded, read-only provider calls. Never upload, bind, submit or invite.
 * Timestamp CAS rotates submissions and claims once per five-minute slot. */
export async function pollAgcInvitations(env: Env, now = Date.now()) {
  if (!env.AGC_CRED_ENC_KEY) return;
  const slot = Math.floor(now / 300_000) * 300_000;
  const { results } = await env.DB.prepare(`SELECT * FROM market_submissions WHERE provider='appgallery'
    AND lane='invitation_test' AND state IN ('testing_review','testing_scheduled','testing_active')
    AND external_app_id IS NOT NULL AND external_version_id IS NOT NULL AND updated_at<?1
    ORDER BY updated_at,id LIMIT 4`).bind(slot).all<AgcSubmission>();
  for (const sub of results) {
    const claim = await env.DB.prepare(`UPDATE market_submissions SET updated_at=?1 WHERE id=?2
      AND state=?3 AND updated_at=?4`).bind(now, sub.id, sub.state, sub.updated_at).run();
    if (claim.meta.changes !== 1) continue;
    sub.updated_at = now;
    try {
      const remote = await getAgcTestVersionStatus(await resolveAgcAppAuth(env, sub.app_id), sub.external_app_id, sub.external_version_id);
      const next = mapAgcTestReleaseState(remote.release_state);
      const detail = { notification_source: "provider_poll", release_state: remote.release_state, audit_opinion: remote.audit_opinion,
        open_test_info: remote.open_test_info, synced_at: now };
      if (next && next !== sub.state) await recordAgcTransition(env.DB, sub, next, detail, null, now);
      else {
        const snapshot = { ...JSON.parse(sub.provider_state_json || "{}"), ...detail };
        await env.DB.prepare(`UPDATE market_submissions SET provider_state_json=?1 WHERE id=?2 AND updated_at=?3 AND state=?4`)
          .bind(JSON.stringify(snapshot), sub.id, now, sub.state).run();
      }
    } catch { console.warn("hands_agc_poll_failure", JSON.stringify({ code: "provider_state_unavailable" })); }
  }
  const packages = await env.DB.prepare(`SELECT * FROM agc_market_packages WHERE state='processing'
    AND external_app_id IS NOT NULL AND external_package_id IS NOT NULL AND updated_at<?1
    ORDER BY updated_at,id LIMIT 4`).bind(slot).all<AgcMarketPackage>();
  for (const pkg of packages.results) {
    const claim = await env.DB.prepare(`UPDATE agc_market_packages SET updated_at=?1
      WHERE id=?2 AND app_id=?3 AND state='processing' AND updated_at=?4`)
      .bind(now,pkg.id,pkg.app_id,pkg.updated_at).run();
    if (claim.meta.changes !== 1) continue;
    pkg.updated_at = now;
    try {
      const remote = await getAgcCompileStatus(await resolveAgcAppAuth(env,pkg.app_id),pkg.external_app_id!,pkg.external_package_id!);
      const raw = remote?.successStatus;
      const code = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      const next = code === AGC_PACKAGE_OK ? "ready" : code === AGC_PACKAGE_FAILED ? "failed" : null;
      if (next) await recordAgcPackageTransition(env.DB,pkg,next,{observed:true},now);
    } catch { console.warn("hands_agc_package_poll_failure", JSON.stringify({code:"provider_state_unavailable"})); }
  }
  await enqueueDueDeliveries(env, Date.now()).catch(() => 0);
}
