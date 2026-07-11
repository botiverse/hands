import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import { agcCredentialKind, getAgcCredentials, type AgcApiClientCredential, type AgcServiceAccountCredential } from "../lib/agc_credentials";
import { addAgcTestPackage, bindAgcTestPackage, createAgcInvitationVersion, createAgcServiceAccountJwt, exchangeAgcApiClientToken, getAgcCompileStatus, requestAgcUpload, resolveAgcAppId, submitAgcTestVersion, uploadAgcObject } from "../lib/agc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type Submission = { id: string; app_id: string; build_id: string; state: string; external_app_id: string; external_version_id: string; external_package_id: string; provider_state_json: string; error_message: string | null; created_at: number; updated_at: number };
function publicSubmission(sub: Submission) {
  return { ...sub, provider_state: JSON.parse(sub.provider_state_json || "{}"), provider_state_json: undefined };
}
async function auth(c: AdminContext) {
  if (!c.env.AGC_CRED_ENC_KEY) throw new Error("server is missing AGC_CRED_ENC_KEY");
  const credential = await getAgcCredentials(c.env.DB, c.env.AGC_CRED_ENC_KEY, c.req.param("appId") ?? "");
  if (!credential) throw new Error("no AGC credentials configured for this app");
  if (agcCredentialKind(credential) === "service_account") {
    return { accessToken: await createAgcServiceAccountJwt(credential as AgcServiceAccountCredential) };
  }
  const api = credential as AgcApiClientCredential;
  const token = await exchangeAgcApiClientToken(api);
  return { clientId: api.client_id, accessToken: token.access_token };
}
async function event(db: D1Database, submissionId: string, state: string, detail: object = {}) {
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE market_submissions SET state=?1, provider_state_json=?2, error_message=NULL, updated_at=?3 WHERE id=?4").bind(state, JSON.stringify(detail), now, submissionId),
    db.prepare("INSERT INTO market_submission_events (id, submission_id, state, detail_json, created_at) VALUES (?1,?2,?3,?4,?5)").bind(crypto.randomUUID(), submissionId, state, JSON.stringify(detail), now),
  ]);
}
export async function handleStartAgcInvitationTest(c: AdminContext) {
  const appId = c.req.param("appId") ?? ""; const buildId = c.req.param("buildId") ?? "";
  const body = await c.req.json().catch(() => ({})) as { package_name?: unknown; test_desc?: unknown; onshelf_self_detect?: unknown };
  const packageName = typeof body.package_name === "string" ? body.package_name.trim() : "";
  const description = typeof body.test_desc === "string" ? body.test_desc.trim() : "Hands invitation test";
  if (!packageName) return c.json({ error: "package_name is required" }, 400);
  const row = await c.env.DB.prepare(`SELECT ba.r2_key, ba.file_hash, ba.size_bytes, ba.filetype
    FROM builds b JOIN build_assets ba ON ba.build_id=b.id
    WHERE b.id=?1 AND b.app_id=?2 AND ba.platform='ohos' AND ba.filetype='app'`).bind(buildId, appId).first<{ r2_key: string; file_hash: string; size_bytes: number; filetype: string }>();
  if (!row) return c.json({ error: "signed OHOS .app asset not found for build" }, 404);
  const existing = await c.env.DB.prepare("SELECT * FROM market_submissions WHERE idempotency_key=?1").bind(`agc-invitation:${buildId}`).first<Submission>();
  if (existing && existing.state !== "failed") return c.json({ submission: publicSubmission(existing) });
  if (existing) await c.env.DB.prepare("DELETE FROM market_submissions WHERE id=?1").bind(existing.id).run();
  const id = crypto.randomUUID(); const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO market_submissions (id,app_id,build_id,provider,lane,state,idempotency_key,created_by_actor,created_at,updated_at)
    VALUES (?1,?2,?3,'appgallery','invitation_test','uploading',?4,?5,?6,?6)`).bind(id, appId, buildId, `agc-invitation:${buildId}`, currentActor(c), now).run();
  try {
    const agcAuth = await auth(c); const externalAppId = await resolveAgcAppId(agcAuth, packageName);
    const versionId = await createAgcInvitationVersion(agcAuth, externalAppId, description, body.onshelf_self_detect === true);
    const fileName = `${packageName}-${buildId}.app`;
    const upload = await requestAgcUpload(agcAuth, externalAppId, fileName, row.file_hash, row.size_bytes);
    const object = await c.env.APK_BUCKET.get(row.r2_key); if (!object?.body) throw new Error("build asset is missing from R2");
    // A buffered body gives the OBS PUT an exact content length. P0B targets
    // ordinary app-sized artifacts; multipart streaming is the follow-up for
    // packages too large to buffer safely in one Worker invocation.
    await uploadAgcObject(upload, await object.arrayBuffer());
    const packageId = await addAgcTestPackage(agcAuth, externalAppId, fileName, upload.objectId);
    await c.env.DB.prepare("UPDATE market_submissions SET external_app_id=?1, external_version_id=?2, external_package_id=?3 WHERE id=?4").bind(externalAppId, versionId, packageId, id).run();
    await event(c.env.DB, id, "processing", { package_name: packageName, external_app_id: externalAppId, version_id: versionId, package_id: packageId });
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_test.upload", payload: { build_id: buildId, submission_id: id, package_name: packageName } });
    return c.json({ submission_id: id, state: "processing", external_app_id: externalAppId, version_id: versionId, package_id: packageId }, 202);
  } catch (e) {
    await c.env.DB.prepare("UPDATE market_submissions SET state='failed', error_message=?1, updated_at=?2 WHERE id=?3").bind((e as Error).message, Date.now(), id).run();
    return c.json({ error: (e as Error).message, submission_id: id }, 502);
  }
}
export async function handleGetAgcBuildSubmission(c: AdminContext) {
  const sub = await c.env.DB.prepare(`SELECT * FROM market_submissions
    WHERE app_id=?1 AND build_id=?2 AND provider='appgallery' AND lane='invitation_test'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(c.req.param("appId") ?? "", c.req.param("buildId") ?? "")
    .first<Submission>();
  return c.json({ submission: sub ? publicSubmission(sub) : null });
}
export async function handleGetAgcSubmission(c: AdminContext) {
  const id = c.req.param("submissionId") ?? "";
  const sub = await c.env.DB.prepare("SELECT * FROM market_submissions WHERE id=?1 AND app_id=?2").bind(id, c.req.param("appId") ?? "").first<Submission>();
  if (!sub) return c.json({ error: "submission not found" }, 404);
  if (sub.state === "processing") {
    const agcAuth = await auth(c); const status = await getAgcCompileStatus(agcAuth, sub.external_app_id, sub.external_package_id);
    if (status && Number(status.successStatus) === 0) {
      await bindAgcTestPackage(agcAuth, sub.external_app_id, sub.external_version_id, sub.external_package_id);
      await event(c.env.DB, id, "ready", { compile_status: status, package_bound: true }); sub.state = "ready";
    }
  }
  const events = await c.env.DB.prepare("SELECT state, detail_json, created_at FROM market_submission_events WHERE submission_id=?1 ORDER BY created_at").bind(id).all();
  return c.json({ submission: publicSubmission(sub), events: events.results });
}
export async function handleSubmitAgcInvitationTest(c: AdminContext) {
  const id = c.req.param("submissionId") ?? ""; const appId = c.req.param("appId") ?? "";
  const sub = await c.env.DB.prepare("SELECT * FROM market_submissions WHERE id=?1 AND app_id=?2").bind(id, appId).first<Submission>();
  if (!sub) return c.json({ error: "submission not found" }, 404);
  if (sub.state !== "ready") return c.json({ error: "package is not ready for testing review" }, 409);
  const agcAuth = await auth(c); await submitAgcTestVersion(agcAuth, sub.external_app_id, sub.external_version_id);
  await event(c.env.DB, id, "testing_review", { submitted: true });
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_test.submit", payload: { submission_id: id, build_id: sub.build_id } });
  return c.json({ ok: true, submission_id: id, state: "testing_review" });
}
