import type { Context } from "hono";
import { resolvePublicChannelSlug } from "../lib/public_channel";

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
  const requestedChannel = c.req.param("channel") || "main";
  const rawFile = c.req.param("file");
  const file = normalizeFileName(rawFile);
  const productType = c.req.query("product_type") || DEFAULT_PRODUCT_TYPE;

  if (!slug) return c.json({ error: "slug required" }, 400);
  if (!file) return c.json({ error: "file required" }, 400);

  // The channel is a path segment here, so the alias applies at lookup time.
  // A real channel named like an alias wins; unknown names pass through and
  // keep the existing no-release response.
  const appRow = await c.env.DB.prepare(
    "SELECT id FROM apps WHERE slug = ?1",
  ).bind(slug).first<{ id: string }>();
  const channel = appRow
    ? await resolvePublicChannelSlug(c.env.DB, appRow.id, requestedChannel)
    : requestedChannel;

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
     ORDER BY r.activated_at DESC, r.id ASC
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

  // electron-updater fetches only the blocks whose checksums changed (differential
  // download) by sending `Range`. Without a 206 it falls back to the whole file, which
  // for this route means 157 MB instead of ~27 MB on macOS. Advertise support always,
  // then answer a satisfiable single range with 206.
  //
  // Only ONE interval is honoured. R2's range option takes a single offset/length, and a
  // multi-interval request would need a multipart/byteranges body to be correct. Rather
  // than emit a wrong 206, fall through to the full 200: electron-updater's own
  // checkIsRangesSupported treats a 200 as "no range support" and re-downloads in full,
  // which is the current behaviour and is safe. Clients that need differential downloads
  // must set useMultipleRangeRequest=false so each block is its own request.
  headers.set("accept-ranges", "bytes");
  // If-Range guards a resumed download against the representation changing underneath it.
  // A client mid-transfer has a partial file for one etag; if the channel now points at a
  // different object, honouring the Range would splice two files together. Anything but an
  // exact etag match therefore drops the Range and answers 200 with the whole current
  // object (RFC 9110). Note the limit: this covers a resume, not two independent requests
  // around a channel switch, which only the client's own checksum can catch.
  const ifRange = c.req.header("if-range")?.trim();
  const rangeHeader =
    ifRange && ifRange !== object.httpEtag ? undefined : c.req.header("range");
  const range = parseSingleByteRange(rangeHeader, asset.size_bytes);
  if (range === "unsatisfiable") {
    // A 416 has no body, so it must not carry the object's Content-Length (set above
    // from asset.size_bytes) nor the representation headers. Reusing that Headers object
    // would promise bytes that never arrive: a client that trusts Content-Length waits
    // for a body until it times out instead of handling the 416. Build a fresh header
    // set for the error response.
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${asset.size_bytes}` },
    });
  }
  if (range) {
    const partial = await c.env.APK_BUCKET.get(asset.r2_key, {
      range: { offset: range.start, length: range.length },
    });
    if (!partial) return c.json({ error: "object not found" }, 404);
    // Length must describe the bytes actually returned, not the whole object.
    headers.set("content-length", String(range.length));
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.start + range.length - 1}/${asset.size_bytes}`,
    );
    return new Response(partial.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

/**
 * Parse a single `bytes=` range against an object of `size` bytes.
 *
 * Returns null when the request is absent, malformed, or asks for more than one
 * interval — the caller then serves the full object, which is what an unsupported
 * Range request is defined to receive. Returns "unsatisfiable" only when the syntax
 * is understood and the range cannot be met, which is a 416.
 */
export function parseSingleByteRange(
  header: string | undefined,
  size: number,
): { start: number; length: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // includes multi-interval `a-b,c-d` and any other unit
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // `bytes=-N`: the final N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    if (size === 0) return "unsatisfiable";
    const start = Math.max(0, size - suffix);
    return { start, length: size - start };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";

  // `bytes=a-` runs to the end of the object.
  if (rawEnd === "") return { start, length: size - start };

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end)) return null;
  if (end < start) return null; // syntactically invalid; serve full rather than 416
  // A range reaching past the end is clamped, not rejected.
  return { start, length: Math.min(end, size - 1) - start + 1 };
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
