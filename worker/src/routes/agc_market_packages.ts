import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import { resolveAgcAuth } from "./agc_testing";
import { addAgcMarketPackage, AGC_PACKAGE_FAILED, AGC_PACKAGE_OK, getAgcCompileStatus, requestAgcUpload, resolveAgcAppId, uploadAgcObject } from "../lib/agc_api";

type Ctx = Context<AdminEnv & { Bindings: Env }>;
type Package = {
  id: string; app_id: string; build_id: string; package_name: string;
  state: "uploading" | "processing" | "ready" | "failed";
  external_app_id: string | null; external_package_id: string | null;
  error_message: string | null; created_at: number; updated_at: number;
};
const lookup = (c: Ctx) => c.env.DB.prepare("SELECT * FROM agc_market_packages WHERE app_id=?1 AND build_id=?2")
  .bind(c.req.param("appId") ?? "", c.req.param("buildId") ?? "").first<Package>();

/** Upload only: never creates a test version, binds a release or submits review. */
export async function handleUploadAgcMarketPackage(c: Ctx) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const body = await c.req.json().catch(() => null);
  const packageName = typeof body?.package_name === "string" ? body.package_name.trim() : "";
  if (!packageName) return c.json({ error: "package_name is required" }, 400);
  const asset = await c.env.DB.prepare(`SELECT ba.r2_key, ba.file_hash, ba.size_bytes
    FROM builds b JOIN apps a ON a.id=b.app_id JOIN build_assets ba ON ba.build_id=b.id
    WHERE b.id=?1 AND b.app_id=?2 AND a.platform='ohos' AND ba.platform='ohos' AND ba.filetype='app'`)
    .bind(buildId, appId).first<{ r2_key: string; file_hash: string; size_bytes: number }>();
  if (!asset) return c.json({ error: "signed OHOS .app asset not found for build" }, 404);
  const existing = await lookup(c);
  if (existing) {
    if (existing.package_name !== packageName) return c.json({ error: "build already has a different package_name" }, 409);
    // Even failed attempts need reconciliation before re-uploading: Huawei may
    // have accepted a request whose response was lost. Never auto-duplicate it.
    return c.json({ package: existing });
  }
  const object = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!object?.body || object.size !== asset.size_bytes) return c.json({ error: "build asset is missing or size does not match" }, 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  const acquired = await c.env.DB.prepare(`INSERT OR IGNORE INTO agc_market_packages
    (id,app_id,build_id,package_name,state,created_at,updated_at) VALUES (?1,?2,?3,?4,'uploading',?5,?5)`)
    .bind(id, appId, buildId, packageName, now).run();
  if (!acquired.meta.changes) {
    await object.body.cancel();
    const winner = await lookup(c);
    if (winner?.package_name !== packageName) return c.json({ error: "build already has a different package_name" }, 409);
    return c.json({ package: winner });
  }
  try {
    const auth = await resolveAgcAuth(c);
    const externalAppId = await resolveAgcAppId(auth, packageName);
    await c.env.DB.prepare("UPDATE agc_market_packages SET external_app_id=?1 WHERE id=?2").bind(externalAppId, id).run();
    const fileName = `${packageName}-${buildId}.app`;
    const upload = await requestAgcUpload(auth, externalAppId, fileName, asset.file_hash, asset.size_bytes);
    // R2 streams have a known length; preserve it through an explicit fixed
    // length stream for OBS, rather than buffering the signed app in memory.
    const stream = new FixedLengthStream(asset.size_bytes);
    const abort = new AbortController();
    const piping = object.body.pipeTo(stream.writable, { signal: abort.signal });
    try {
      await Promise.all([piping, uploadAgcObject(upload, stream.readable)]);
    } catch (error) {
      abort.abort();
      await piping.catch(() => {});
      throw error;
    }
    const packageId = await addAgcMarketPackage(auth, externalAppId, fileName, upload.objectId);
    await c.env.DB.prepare("UPDATE agc_market_packages SET state='processing', external_package_id=?1, updated_at=?2 WHERE id=?3")
      .bind(packageId, Date.now(), id).run();
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_market_package.upload", payload: { build_id: buildId, package_id: packageId, package_name: packageName } });
    return c.json({ package: await lookup(c) }, 202);
  } catch {
    // Do not persist raw provider/auth errors (may include signed URLs/keys).
    const message = "AppGallery package upload failed; reconcile this attempt before retrying";
    await c.env.DB.prepare("UPDATE agc_market_packages SET state='failed',error_message=?1,updated_at=?2 WHERE id=?3 AND state='uploading'")
      .bind(message, Date.now(), id).run();
    return c.json({ error: message, package: await lookup(c) }, 502);
  }
}

export async function handleGetAgcMarketPackage(c: Ctx) {
  const pkg = await lookup(c);
  if (!pkg) return c.json({ package: null });
  if (pkg.state === "processing" && pkg.external_app_id && pkg.external_package_id) {
    try {
      const status = await getAgcCompileStatus(await resolveAgcAuth(c), pkg.external_app_id, pkg.external_package_id);
      const raw = status?.successStatus;
      const code = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      const state = code === AGC_PACKAGE_OK ? "ready" : code === AGC_PACKAGE_FAILED ? "failed" : null;
      if (state) {
        await c.env.DB.prepare("UPDATE agc_market_packages SET state=?1,error_message=?2,updated_at=?3 WHERE id=?4 AND state='processing'")
          .bind(state, state === "failed" ? "AppGallery package parsing failed" : null, Date.now(), pkg.id).run();
      }
    } catch { return c.json({ package: pkg, sync_error: "AppGallery package status is unavailable" }); }
  }
  return c.json({ package: await lookup(c) });
}
