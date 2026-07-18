import type { Context } from "hono";

type TauriRelease = {
  build_id: string;
  version_name: string;
  changelog: string | null;
  created_at: number;
};

type TauriAsset = {
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  r2_key: string;
  size_bytes: number;
  signature: string | null;
  metadata_json: string;
};

const PRODUCT_TYPE = "tauri-updater";

export async function handleTauriUpdate(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug") ?? "";
  const channel = c.req.param("channel") || "main";
  const target = normalizeTarget(c.req.param("target") ?? "");
  const arch = normalizeArch(c.req.param("arch") ?? "");
  const currentVersion = c.req.param("currentVersion") ?? "";
  if (!slug || !target || !arch || !parseSemver(currentVersion)) {
    return c.json({ error: "invalid Tauri updater parameters" }, 400);
  }

  const release = await findActiveRelease(c.env.DB, slug, channel);
  if (!release) return new Response(null, { status: 204, headers: noStoreHeaders() });
  if (!parseSemver(release.version_name)) {
    return c.json({ error: "active Tauri release has invalid semver" }, 500);
  }
  if (compareSemver(release.version_name, currentVersion) <= 0) {
    return new Response(null, { status: 204, headers: noStoreHeaders() });
  }

  const asset = await findAsset(c.env.DB, release.build_id, target, arch);
  if (!asset || !asset.signature) {
    return c.json({ error: "active Tauri release is missing a matching signed updater artifact" }, 404);
  }
  const fileName = assetName(asset);
  if (!fileName) return c.json({ error: "Tauri updater artifact has no public filename" }, 500);
  const origin = new URL(c.req.url).origin;
  const publicTarget = target === "win32" ? "windows" : target;
  const url = `${origin}/tauri/${encodeURIComponent(slug)}/${encodeURIComponent(channel)}/artifacts/${publicTarget}/${arch}/${encodeURIComponent(fileName)}`;

  return c.json({
    version: release.version_name,
    url,
    signature: asset.signature,
    notes: release.changelog ?? undefined,
    pub_date: new Date(release.created_at).toISOString(),
  }, 200, { "cache-control": "public, max-age=60, must-revalidate" });
}

export async function handleTauriArtifact(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug") ?? "";
  const channel = c.req.param("channel") || "main";
  const target = normalizeTarget(c.req.param("target") ?? "");
  const arch = normalizeArch(c.req.param("arch") ?? "");
  const file = decodeFileName(c.req.param("file") ?? "");
  if (!slug || !target || !arch || !file) return c.json({ error: "invalid Tauri artifact parameters" }, 400);

  const release = await findActiveRelease(c.env.DB, slug, channel);
  if (!release) return c.json({ error: "no active Tauri release found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT platform, arch, variant, filetype, r2_key, size_bytes, signature, metadata_json
     FROM build_assets WHERE build_id = ?1 AND artifact_kind = 'tauri-updater'
       AND platform = ?2 AND arch = ?3`,
  ).bind(release.build_id, target, arch).all<TauriAsset>();
  const asset = results.find((candidate) => assetName(candidate) === file);
  if (!asset) return c.json({ error: "Tauri updater artifact not found" }, 404);

  const object = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!object) return c.json({ error: "object not found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-type", contentType(asset.filetype));
  headers.set("content-length", String(asset.size_bytes));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
  return new Response(object.body, { headers });
}

async function findActiveRelease(db: D1Database, slug: string, channel: string): Promise<TauriRelease | null> {
  return await db.prepare(
    `SELECT b.id AS build_id, b.version_name, r.changelog, r.created_at
     FROM apps a
     JOIN channels ch ON ch.app_id = a.id
     JOIN releases r ON r.app_id = a.id AND r.channel_id = ch.id
     JOIN builds b ON b.id = r.build_id
     WHERE a.slug = ?1 AND ch.slug = ?2 AND r.product_type = ?3
       AND r.status = 'active' AND (r.availability_at IS NULL OR r.availability_at <= ?4)
     ORDER BY r.created_at DESC, r.id ASC LIMIT 1`,
  ).bind(slug, channel, PRODUCT_TYPE, Date.now()).first<TauriRelease>();
}

async function findAsset(db: D1Database, buildId: string, platform: string, arch: string): Promise<TauriAsset | null> {
  return await db.prepare(
    `SELECT platform, arch, variant, filetype, r2_key, size_bytes, signature, metadata_json
     FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'tauri-updater'
       AND platform = ?2 AND arch = ?3
     ORDER BY created_at ASC LIMIT 1`,
  ).bind(buildId, platform, arch).first<TauriAsset>();
}

function normalizeTarget(target: string): string | null {
  if (target === "darwin" || target === "linux") return target;
  if (target === "windows" || target === "win32") return "win32";
  return null;
}

function normalizeArch(arch: string): string | null {
  if (arch === "x86_64" || arch === "aarch64" || arch === "i686" || arch === "armv7") return arch;
  return null;
}

function assetName(asset: TauriAsset): string | null {
  if (asset.variant) return asset.variant;
  try {
    const metadata = JSON.parse(asset.metadata_json || "{}") as Record<string, unknown>;
    if (typeof metadata.filename === "string" && metadata.filename) return metadata.filename;
  } catch { /* use R2 basename */ }
  return asset.r2_key.split("/").pop() ?? null;
}

function decodeFileName(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function contentType(filetype: string): string {
  if (filetype === "tar.gz") return "application/gzip";
  return "application/zip";
}

function noStoreHeaders(): HeadersInit {
  return { "cache-control": "no-store" };
}

type Semver = [number, number, number, string[]];

function parseSemver(value: string): Semver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split(".") ?? []];
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error("invalid semver");
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] as number) > (b[index] as number) ? 1 : -1;
  }
  if (a[3].length === 0 || b[3].length === 0) return a[3].length === b[3].length ? 0 : a[3].length === 0 ? 1 : -1;
  const length = Math.max(a[3].length, b[3].length);
  for (let index = 0; index < length; index++) {
    const x = a[3][index];
    const y = b[3][index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
