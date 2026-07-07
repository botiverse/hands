import type { Context } from "hono";

type ElectronAssetRow = {
  id: string;
  artifact_kind: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  r2_key: string;
  size_bytes: number;
  metadata_json: string;
};

const DEFAULT_PRODUCT_TYPE = "electron-installer";
const ELECTRON_METADATA_KINDS = new Set([
  "electron-metadata",
  "update-metadata",
  "metadata",
]);

export async function handleElectronGenericAsset(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  const channel = c.req.param("channel") || "main";
  const rawFile = c.req.param("file");
  const file = normalizeFileName(rawFile);
  const productType = c.req.query("product_type") || DEFAULT_PRODUCT_TYPE;

  if (!slug) return c.json({ error: "slug required" }, 400);
  if (!file) return c.json({ error: "file required" }, 400);

  const build = await c.env.DB.prepare(
    `SELECT b.id AS build_id
     FROM apps a
     JOIN channels ch ON ch.app_id = a.id
     JOIN releases r ON r.app_id = a.id AND r.channel_id = ch.id
     JOIN builds b ON b.id = r.build_id
     WHERE a.slug = ?1
       AND ch.slug = ?2
       AND r.product_type = ?3
       AND r.status = 'active'
     ORDER BY r.created_at DESC, r.id ASC
     LIMIT 1`,
  )
    .bind(slug, channel, productType)
    .first<{ build_id: string }>();

  if (!build) {
    return c.json(
      {
        error: "no active Electron release found",
        app: slug,
        channel,
        product_type: productType,
      },
      404,
    );
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, artifact_kind, platform, arch, variant, filetype, r2_key,
            size_bytes, metadata_json
     FROM build_assets
     WHERE build_id = ?1
     ORDER BY artifact_kind DESC, platform ASC, arch ASC, filetype ASC, created_at ASC`,
  )
    .bind(build.build_id)
    .all<ElectronAssetRow>();

  const asset = selectElectronAsset(file, results);
  if (!asset) {
    return c.json(
      {
        error: "Electron release asset not found",
        app: slug,
        channel,
        product_type: productType,
        file,
      },
      404,
    );
  }

  const object = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!object) return c.json({ error: "object not found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", cacheControlForElectronAsset(asset));
  headers.set("content-type", contentTypeForElectronAsset(asset));
  headers.set("content-length", String(asset.size_bytes));
  headers.set("content-disposition", contentDispositionForElectronAsset(file, asset));
  return new Response(object.body, { headers });
}

function normalizeFileName(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function selectElectronAsset(
  requestedFile: string,
  assets: ElectronAssetRow[],
): ElectronAssetRow | null {
  const metadataTarget = electronMetadataTarget(requestedFile);
  if (metadataTarget) {
    return findByName(
      assets.filter((asset) => isElectronMetadataAsset(asset)),
      requestedFile,
      metadataTarget.platform,
    );
  }
  return findByName(
    assets.filter((asset) => !isElectronMetadataAsset(asset)),
    requestedFile,
    null,
  );
}

function electronMetadataTarget(file: string): { platform: string | null } | null {
  if (!/\.ya?ml$/i.test(file)) return null;
  if (file.endsWith("-mac.yml") || file.endsWith("-mac.yaml")) {
    return { platform: "darwin" };
  }
  if (file.endsWith("-linux.yml") || file.endsWith("-linux.yaml")) {
    return { platform: "linux" };
  }
  return { platform: "win32" };
}

function isElectronMetadataAsset(asset: ElectronAssetRow): boolean {
  return ELECTRON_METADATA_KINDS.has(asset.artifact_kind) ||
    asset.filetype === "yml" ||
    asset.filetype === "yaml";
}

function findByName(
  assets: ElectronAssetRow[],
  requestedFile: string,
  platform: string | null,
): ElectronAssetRow | null {
  const platformMatches = platform
    ? assets.filter((asset) => asset.platform === platform)
    : assets;
  const pool = platformMatches.length > 0 ? platformMatches : assets;
  return pool.find((asset) => candidateNames(asset).has(requestedFile)) ?? null;
}

function candidateNames(asset: ElectronAssetRow): Set<string> {
  const names = new Set<string>();
  if (asset.variant) names.add(asset.variant);
  const basename = asset.r2_key.split("/").pop();
  if (basename) names.add(basename);
  const metadata = parseMetadata(asset.metadata_json);
  for (const key of ["filename", "name", "path", "url"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      const leaf = value.split("/").pop();
      names.add(value);
      if (leaf) names.add(leaf);
    }
  }
  return names;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cacheControlForElectronAsset(asset: ElectronAssetRow): string {
  if (isElectronMetadataAsset(asset)) {
    return "public, max-age=60, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function contentDispositionForElectronAsset(
  file: string,
  asset: ElectronAssetRow,
): string {
  const disposition = isElectronMetadataAsset(asset) ? "inline" : "attachment";
  return `${disposition}; filename="${asciiFilename(file)}"; filename*=UTF-8''${encodeURIComponent(file)}`;
}

function asciiFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/"/g, "_") || "artifact";
}

function contentTypeForElectronAsset(asset: ElectronAssetRow): string {
  if (isElectronMetadataAsset(asset)) return "text/yaml; charset=utf-8";
  switch (asset.filetype.toLowerCase()) {
    case "blockmap":
      return "application/octet-stream";
    case "dmg":
      return "application/x-apple-diskimage";
    case "exe":
      return "application/vnd.microsoft.portable-executable";
    case "appimage":
      return "application/octet-stream";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
