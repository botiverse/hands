import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { presignR2DownloadUrl } from "../lib/r2_presign";
import { generateSignedR2Url } from "./public_v2";
import { requestOrigin } from "../lib/origin";
import { emitWebhookEvent } from "./webhooks";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type JsonRecord = Record<string, unknown>;

export interface BuildInput {
  channel_id: string;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  changelog?: string | null;
  source?: string;
  // Where the bytes live (0073). Defaults to 'hands_r2'; the external publish path passes
  // 'external'. Read this - not `source` - to ask whether the bytes are hosted by us.
  artifact_mode?: ArtifactMode;
  status?: string;
  build_metadata_json?: unknown;
  parsed_metadata_json?: unknown;
  provenance_json?: unknown;
  should_force_update?: boolean;
  availability_at?: number | null;
  asset_ingest_protocol_version?: number | null;
  required_asset_slots_json?: Array<{
    artifact_kind?: string;
    platform: string;
    arch?: string | null;
    variant?: string | null;
    filetype: string;
  }> | null;
}

export interface BuildAssetInput {
  artifact_kind?: string;
  platform: string;
  arch?: string | null;
  variant?: string | null;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  signing_credential_id?: string | null;
  metadata_json?: unknown;
}

export interface ExternalBuildVersionInput {
  channel_id: string;
  version_name: string;
  version_code: number;
  target: string;
  source_url: string;
  raw_sha256: string;
  raw_size_bytes: number;
  gzip_sha256?: string | null;
  gzip_size_bytes?: number | null;
  gzip_source_url?: string | null;
  node_version?: string | null;
  product_type?: string;
  release_type?: string;
  metadata_json?: unknown;
  provenance_json?: unknown;
}

interface ExternalBuildTargetRow {
  id: string;
  app_id: string;
  build_id: string;
  version_name: string;
  target: string;
  source_url: string;
  raw_sha256: string;
  raw_size_bytes: number;
  gzip_sha256: string | null;
  gzip_size_bytes: number | null;
  node_version: string | null;
  metadata_json: string;
}

interface BuildRow {
  id: string;
  app_id: string;
  channel_id: string | null;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  changelog: string | null;
  // `source` records WHICH CREATION PATH produced the build. The values the code writes are:
  //
  //   'web'          - created from the console; this is the DEFAULT (see createBuild)
  //   'cli'          - created by the CLI publish commands (packages/cli)
  //   'qa-artifact'  - created by the QA artifact route (qa_artifacts.ts)
  //   'external'     - created by external publish-version (builds.ts)
  //   'mobile-ci'    - created by the Android release-artifact route
  //                    (android_release_artifacts.ts). No production row carries this value
  //                    yet (census 2026-09-15), but the writer is live code.
  //
  // HOW THIS LIST WAS DERIVED (reproducible — please re-run rather than trust it):
  //   enumerate the call sites of `createBuild` in worker/src and read the `source`
  //   argument of each, then add this function's own `input.source ?? "web"` default.
  //     grep -rn "createBuild(" worker/src --include=*.ts
  //   The CLI passes 'cli' from packages/cli (outside worker/src), so it must be added
  //   separately. Do NOT derive the list by scanning production rows: a live writer with
  //   no rows yet ('mobile-ci') is invisible that way, and an abandoned value would look
  //   real. Do NOT derive it by grepping `source:` across the repo either — that also
  //   matches unrelated properties (feedback.ts has source:'inline'/'presigned', and
  //   android_release_artifacts.ts has a CI provenance `source` object), yielding three
  //   false positives. worker/test/build_source_domain.test.ts performs exactly this
  //   createBuild-scoped enumeration, so the test and this comment cannot drift apart.
  //
  // Of these, only 'external' is a LIVE CRITERION — readers branch on it because it is the
  // one value that ALSO carries a claim about WHERE THE BYTES LIVE (declared URLs in
  // external_build_targets, no R2 objects). The others are PROVENANCE RECORDS ONLY:
  // nothing reads them, and they need no attribution rule.
  // (Verified 2026-09-15: exactly TWO sites depend on source='external' as a criterion —
  //  external_dl.ts and getExternalBuild below. releases.ts gates on it too (source !==
  //  'external'). public_v2.ts merely *mentions* 'external' in a comment; its logic already
  //  keys off build_assets (`assets.results.length === 0`), so it is the reference for the
  //  correct approach rather than a site that needs changing. Be precise about this
  //  distinction: counting grep hits conflates "logic depends on it" with "a comment
  //  mentions it".)
  //
  // Do NOT use `source` as the general test for "is this build externally hosted".
  // Read `artifact_mode` instead (see ArtifactMode): it states placement directly, so a build
  // whose bytes are external is found regardless of which creation path produced it. As of
  // 0073 all three former label-readers use it (external_dl.ts, getExternalBuild here, and
  // the releases.ts required_external_targets gate).
  // public_v2.ts attributes by build_assets presence, which agrees with artifact_mode;
  // it mentions the label only in a comment.
  //
  // Careful: `apps.ts` also mentions 'external', but for product_type registration
  // (parser_kind='external'). That is a different axis — do not count it as a reader here.
  //
  // 'ci' appears in some older documents (0005 migration comment,
  // docs/publish-architecture.md) but is NEVER WRITTEN anywhere in this repo. Treat it as
  // dead; do not implement against it.
  //
  // worker/test/build_source_domain.test.ts pins this list against the actual writers.
  source: string;
  status: string;
  build_metadata_json: string;
  parsed_metadata_json: string;
  should_force_update: number;
  availability_at: number | null;
  asset_ingest_protocol_version: number | null;
  required_asset_slots_json: string | null;
  provenance_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  // Present on every row (0073, NOT NULL DEFAULT 'hands_r2'). Required here because a
  // selected row always has it; optionality would hide a missing SELECT column.
  artifact_mode: ArtifactMode;
}

/**
 * Where a build's bytes live. Mirrors the `builds.artifact_mode` domain (0073).
 *
 * 'hands_r2' - bytes are objects under `build_assets.r2_key` (our own bucket).
 * 'external' - bytes are declared URLs in `external_build_targets`; there is no R2 object.
 *
 * This is the correct thing to read when the question is "are these bytes hosted by us?".
 * Prefer it over `source`: `source` records the CREATION PATH, and only its 'external'
 * value coincidentally also implies placement, which is why this column exists.
 */
export type ArtifactMode = "hands_r2" | "external";

interface BuildAssetDownloadRow {
  id: string;
  artifact_kind: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  r2_key: string;
  size_bytes: number;
  app_slug: string;
  version_name: string;
  version_code: number;
}

interface InstallerAssetIngestionRow {
  id: string;
  file_hash: string;
  size_bytes: number;
  version_code: number;
}

const APK_INSPECTOR_VERSION = "android-apksig-34.0.0-v1";

function verifiedApkMetadata(metadata: Record<string, unknown>, asset: InstallerAssetIngestionRow) {
  const raw = metadata.raw;
  const lineages = raw && typeof raw === "object"
    ? (raw as Record<string, unknown>).signer_lineages
    : null;
  if (
    metadata.parser_kind !== "apk-aapt" ||
    metadata.platform !== "android" ||
    typeof metadata.package_id !== "string" ||
    metadata.package_id.length < 1 ||
    metadata.package_id.length > 255 ||
    !Number.isInteger(metadata.version_code) ||
    (metadata.version_code as number) < 0 ||
    metadata.version_code !== asset.version_code ||
    metadata.file_hash_sha256 !== asset.file_hash ||
    metadata.size_bytes !== asset.size_bytes ||
    !Array.isArray(lineages) ||
    lineages.length < 1 ||
    lineages.length > 8
  ) return null;

  const seen = new Set<string>();
  const signerLineages: string[][] = [];
  for (const entry of lineages) {
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 16) return null;
    const lineage: string[] = [];
    for (const fingerprint of entry) {
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
      if (seen.has(fingerprint)) return null;
      seen.add(fingerprint);
      lineage.push(fingerprint);
    }
    signerLineages.push(lineage);
  }
  return {
    packageId: metadata.package_id,
    versionCode: metadata.version_code as number,
    fileHash: metadata.file_hash_sha256 as string,
    signerLineages,
  };
}

function jsonString(value: unknown, fallback: JsonRecord = {}): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? fallback);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function externalJsonString(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(canonicalJson(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  return JSON.stringify(canonicalJson(value ?? {}));
}

const BUILD_TARGET_PATTERN = /^(darwin|linux|win32)-(arm64|x64)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export function splitBuildTarget(target: string): { platform: string; arch: string } {
  const match = BUILD_TARGET_PATTERN.exec(target);
  if (!match) {
    throw new Error(
      "target must be darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, or win32-x64",
    );
  }
  return { platform: match[1]!, arch: match[2]! };
}

function normalizeSha256(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  return value.toLowerCase();
}

function normalizeExternalBuildInput(input: ExternalBuildVersionInput): ExternalBuildVersionInput {
  if (!input.channel_id || !input.version_name || !input.target || !input.source_url) {
    throw new Error("channel_id, version_name, target, source_url required");
  }
  splitBuildTarget(input.target);
  const source = new URL(input.source_url);
  if (source.protocol !== "https:") throw new Error("source_url must use https");
  if (source.username || source.password) {
    throw new Error("source_url must not contain embedded credentials");
  }
  if (!Number.isSafeInteger(Number(input.version_code)) || Number(input.version_code) < 0) {
    throw new Error("version_code must be a non-negative integer");
  }
  if (!Number.isSafeInteger(Number(input.raw_size_bytes)) || Number(input.raw_size_bytes) < 0) {
    throw new Error("raw_size_bytes must be a non-negative integer");
  }
  const hasGzipHash = input.gzip_sha256 !== undefined && input.gzip_sha256 !== null;
  const hasGzipSize = input.gzip_size_bytes !== undefined && input.gzip_size_bytes !== null;
  if (hasGzipHash !== hasGzipSize) {
    throw new Error("gzip_sha256 and gzip_size_bytes must be provided together");
  }
  if (hasGzipSize && (!Number.isSafeInteger(Number(input.gzip_size_bytes)) || Number(input.gzip_size_bytes) < 0)) {
    throw new Error("gzip_size_bytes must be a non-negative integer");
  }
  return {
    ...input,
    version_code: Number(input.version_code),
    raw_sha256: normalizeSha256(input.raw_sha256, "raw_sha256"),
    raw_size_bytes: Number(input.raw_size_bytes),
    gzip_sha256: hasGzipHash ? normalizeSha256(input.gzip_sha256 as string, "gzip_sha256") : null,
    gzip_size_bytes: hasGzipSize ? Number(input.gzip_size_bytes) : null,
    node_version: input.node_version?.trim() || null,
    product_type: input.product_type ?? "cli-binary",
    release_type: input.release_type ?? "stable",
  };
}

function externalDeclarationMatches(
  existing: ExternalBuildTargetRow,
  input: ExternalBuildVersionInput,
): boolean {
  return (
    existing.source_url === input.source_url &&
    existing.raw_sha256 === input.raw_sha256 &&
    existing.raw_size_bytes === input.raw_size_bytes &&
    existing.gzip_sha256 === (input.gzip_sha256 ?? null) &&
    existing.gzip_size_bytes === (input.gzip_size_bytes ?? null) &&
    existing.node_version === (input.node_version ?? null) &&
    existing.metadata_json === externalJsonString(input.metadata_json)
  );
}

interface ExternalBuildRow {
  id: string;
  channel_id: string;
  product_type: string;
  release_type: string;
  version_code: number;
  provenance_json: string;
}

function externalVersionMatches(
  existing: ExternalBuildRow,
  input: ExternalBuildVersionInput,
): boolean {
  return (
    existing.channel_id === input.channel_id &&
    existing.product_type === input.product_type &&
    existing.release_type === input.release_type &&
    existing.version_code === input.version_code &&
    existing.provenance_json === externalJsonString(input.provenance_json)
  );
}

async function getExternalBuild(
  db: D1Database,
  appId: string,
  versionName: string,
): Promise<ExternalBuildRow | null> {
  // Now reads the placement column directly rather than inferring it from the `source`
  // label: `artifact_mode = 'external'` means the bytes are declared in
  // external_build_targets with no R2 object. This is exact, so a future writer that stores
  // bytes elsewhere under a different `source` value is still found here.
  return await db
    .prepare(
      `SELECT id, channel_id, product_type, release_type, version_code, provenance_json
       FROM builds
       WHERE app_id = ?1 AND version_name = ?2 AND artifact_mode = 'external'`,
    )
    .bind(appId, versionName)
    .first<ExternalBuildRow>();
}

async function getExternalTarget(
  db: D1Database,
  appId: string,
  versionName: string,
  target: string,
): Promise<ExternalBuildTargetRow | null> {
  return await db
    .prepare(
      `SELECT id, app_id, build_id, version_name, target, source_url,
              raw_sha256, raw_size_bytes, gzip_sha256, gzip_size_bytes,
              node_version, metadata_json
       FROM external_build_targets
       WHERE app_id = ?1 AND version_name = ?2 AND target = ?3`,
    )
    .bind(appId, versionName, target)
    .first<ExternalBuildTargetRow>();
}

async function insertAuditLog(
  db: D1Database,
  appId: string,
  action: string,
  actor: string,
  payload: unknown,
  now = Date.now(),
) {
  await db
    .prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(crypto.randomUUID(), appId, action, actor, JSON.stringify(payload), now)
    .run();
}

export async function getBuildForApp(
  db: D1Database,
  appId: string,
  buildId: string,
): Promise<BuildRow | null> {
  return await db
    .prepare("SELECT * FROM builds WHERE app_id = ?1 AND id = ?2")
    .bind(appId, buildId)
    .first<BuildRow>();
}

export async function createBuild(
  db: D1Database,
  appId: string,
  input: BuildInput,
  actor: string,
  id = crypto.randomUUID(),
): Promise<string> {
  if (!input.channel_id || !input.product_type) {
    throw new Error("channel_id, product_type required");
  }
  if (!input.version_name || !Number.isFinite(Number(input.version_code))) {
    throw new Error("version_name, version_code required");
  }
  if (input.asset_ingest_protocol_version !== undefined && input.asset_ingest_protocol_version !== null) {
    if (input.asset_ingest_protocol_version !== 1) {
      throw new Error("asset_ingest_protocol_version must be 1");
    }
    if ((input.status ?? "pending") !== "pending") {
      throw new Error("direct asset ingest builds must start pending");
    }
    if (!Array.isArray(input.required_asset_slots_json) || input.required_asset_slots_json.length === 0) {
      throw new Error("required_asset_slots_json must contain at least one slot");
    }
    const keys = new Set<string>();
    for (const slot of input.required_asset_slots_json) {
      if (!slot?.platform || !slot.filetype) throw new Error("required asset slots need platform and filetype");
      if (slot.arch === "-" || slot.variant === "-") throw new Error("required asset slot arch/variant cannot be '-'");
      const key = JSON.stringify([
        slot.artifact_kind ?? "installable",
        slot.platform,
        slot.arch ?? null,
        slot.variant ?? null,
        slot.filetype,
      ]);
      if (keys.has(key)) throw new Error("required_asset_slots_json contains a duplicate slot");
      keys.add(key);
    }
  }

  const channel = await db
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND id = ?2")
    .bind(appId, input.channel_id)
    .first<{ id: string }>();
  if (!channel) throw new Error("channel_id not found for app");

  const now = Date.now();
  const commonBinds = [
    id,
    appId,
    input.channel_id,
    input.product_type,
    input.release_type ?? "stable",
    input.version_name,
    Number(input.version_code),
    input.changelog ?? null,
    // Default creation path is the console ('web'); see BuildInput.source for the
    // documented domain and the fact-based attribution rule.
    input.source ?? "web",
    input.status ?? "pending",
    jsonString(input.build_metadata_json),
    jsonString(input.parsed_metadata_json),
    input.should_force_update ? 1 : 0,
    input.availability_at ?? null,
    jsonString(input.provenance_json),
    now,
    now,
    input.status === "succeeded" ? now : null,
    // Defaults to 'hands_r2' (matches the DB default). Writers that store bytes outside
    // R2 must pass 'external' explicitly; see the external publish path below.
    input.artifact_mode ?? "hands_r2",
  ] as const;
  if (input.asset_ingest_protocol_version === 1) {
    await db.prepare(
      `INSERT INTO builds
       (id, app_id, channel_id, product_type, release_type, version_name,
        version_code, changelog, source, status, build_metadata_json,
        parsed_metadata_json, should_force_update, availability_at,
        provenance_json, created_at, updated_at, completed_at, artifact_mode,
        asset_ingest_protocol_version, required_asset_slots_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    ).bind(
      ...commonBinds,
      input.asset_ingest_protocol_version ?? null,
      input.required_asset_slots_json === undefined || input.required_asset_slots_json === null
        ? null
        : JSON.stringify(input.required_asset_slots_json),
    ).run();
  } else {
    // Keep the legacy insert shape for ordinary writers and older local test
    // schemas. Protocol columns are only required by the new direct-ingest path.
    await db.prepare(
      `INSERT INTO builds
       (id, app_id, channel_id, product_type, release_type, version_name,
        version_code, changelog, source, status, build_metadata_json,
        parsed_metadata_json, should_force_update, availability_at,
        provenance_json, created_at, updated_at, completed_at, artifact_mode)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
    ).bind(...commonBinds).run();
  }

  await insertAuditLog(
    db,
    appId,
    "build.create",
    actor,
    { id, ...input, release_type: input.release_type ?? "stable" },
    now,
  );
  return id;
}

export async function createBuildAsset(
  db: D1Database,
  appId: string,
  buildId: string,
  input: BuildAssetInput,
  actor: string,
  id = crypto.randomUUID(),
): Promise<string> {
  if (!input.platform || !input.filetype || !input.r2_key || !input.file_hash) {
    throw new Error("platform, filetype, r2_key, file_hash required");
  }
  if (!Number.isFinite(Number(input.size_bytes))) {
    throw new Error("size_bytes required");
  }
  const build = await getBuildForApp(db, appId, buildId);
  if (!build) throw new Error("build not found");

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO build_assets
       (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key, file_hash,
        size_bytes, signing_credential_id, metadata_json,
        download_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13)`,
    )
    .bind(
      id,
      buildId,
      input.artifact_kind ?? "installable",
      input.platform,
      input.arch ?? null,
      input.variant ?? null,
      input.filetype,
      input.r2_key,
      input.file_hash,
      Number(input.size_bytes),
      input.signing_credential_id ?? null,
      jsonString(input.metadata_json),
      now,
    )
    .run();

  await insertAuditLog(db, appId, "build_asset.create", actor, { id, buildId, ...input }, now);
  return id;
}

export async function resolveChannelId(
  db: D1Database,
  appId: string,
  channelIdOrSlug: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND (id = ?2 OR slug = ?3)")
    .bind(appId, channelIdOrSlug, channelIdOrSlug)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function handleListBuilds(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const conditions = ["b.app_id = ?1"];
  const binds: (string | number)[] = [appId];
  const productType = c.req.query("product_type");
  const channel = c.req.query("channel");
  const status = c.req.query("status");
  const versionName = c.req.query("version_name");

  if (productType) {
    conditions.push(`b.product_type = ?${binds.length + 1}`);
    binds.push(productType);
  }
  if (channel) {
    conditions.push(`(c.id = ?${binds.length + 1} OR c.slug = ?${binds.length + 2})`);
    binds.push(channel, channel);
  }
  if (status) {
    conditions.push(`b.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (versionName) {
    conditions.push(`b.version_name = ?${binds.length + 1}`);
    binds.push(versionName);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.app_id, b.channel_id, c.slug AS channel, b.product_type,
            b.release_type, b.status, b.version_name, b.version_code,
            b.changelog, b.source, b.should_force_update, b.availability_at,
            b.provenance_json, b.created_at, b.updated_at, b.completed_at
     FROM builds b
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY b.created_at DESC
     LIMIT 200`,
  )
    .bind(...binds)
    .all();

  return c.json({ builds: results });
}

export async function handleGetBuild(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT b.*, c.slug AS channel
     FROM builds b
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.app_id = ?1 AND b.id = ?2`,
  )
    .bind(appId, buildId)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}

export async function handlePublishExternalBuildVersion(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  let input: ExternalBuildVersionInput;
  try {
    input = normalizeExternalBuildInput((await c.req.json()) as ExternalBuildVersionInput);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_EXTERNAL_BUILD" }, 400);
  }

  const app = await c.env.DB.prepare("SELECT id, platform FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string; platform: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);
  if (app.platform !== "node") {
    return c.json(
      {
        error: "external Node build publishing requires app platform 'node'",
        code: "APP_PLATFORM_MISMATCH",
        app_platform: app.platform,
      },
      409,
    );
  }

  const channel = await c.env.DB
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND id = ?2")
    .bind(appId, input.channel_id)
    .first<{ id: string }>();
  if (!channel) return c.json({ error: "channel_id not found for app" }, 400);

  let build = await getExternalBuild(c.env.DB, appId, input.version_name);

  if (build) {
    if (!externalVersionMatches(build, input)) {
      return c.json(
        {
          error: "external version metadata conflicts with the existing immutable version",
          code: "EXTERNAL_VERSION_CONFLICT",
          build_id: build.id,
        },
        409,
      );
    }
  }

  const replay = await getExternalTarget(c.env.DB, appId, input.version_name, input.target);
  if (replay) {
    if (!externalDeclarationMatches(replay, input)) {
      return c.json(
        {
          error: "external build declaration conflicts with the existing immutable target",
          code: "EXTERNAL_BUILD_CONFLICT",
          build_id: replay.build_id,
          target_id: replay.id,
          target: replay.target,
        },
        409,
      );
    }
    const { platform, arch } = splitBuildTarget(input.target);
    return c.json({
      app_id: appId,
      build_id: replay.build_id,
      target_id: replay.id,
      version: input.version_name,
      target: input.target,
      platform,
      arch,
      replayed: true,
    });
  }

  if (!build) {
    const buildId = crypto.randomUUID();
    try {
      await createBuild(
        c.env.DB,
        appId,
        {
          channel_id: input.channel_id,
          product_type: input.product_type!,
          release_type: input.release_type!,
          version_name: input.version_name,
          version_code: input.version_code,
          // 'external' = bytes are declared via external_build_targets, not stored in R2.
          // This is the only `source` value that asserts placement; see BuildInput.source.
          source: "external",
          // The same fact stated in the column that actually means it. New readers should
          // use artifact_mode; `source` remains the creation path.
          artifact_mode: "external",
          status: "succeeded",
          build_metadata_json: { external_source: true },
          provenance_json: externalJsonString(input.provenance_json),
        },
        currentActor(c),
        buildId,
      );
      build = {
        id: buildId,
        channel_id: input.channel_id,
        product_type: input.product_type!,
        release_type: input.release_type!,
        version_code: input.version_code,
        provenance_json: externalJsonString(input.provenance_json),
      };
    } catch (error) {
      build = await getExternalBuild(c.env.DB, appId, input.version_name);
      if (!build) throw error;
      if (!externalVersionMatches(build, input)) {
        return c.json(
          {
            error: "external version metadata conflicts with the existing immutable version",
            code: "EXTERNAL_VERSION_CONFLICT",
            build_id: build.id,
          },
          409,
        );
      }
    }
  }

  const targetId = crypto.randomUUID();
  const now = Date.now();
  // gzip transport must be explicitly addressable (never consumer-guessed):
  // caller may pass gzip_source_url; when a gzip digest exists without one,
  // the server normalizes to source_url + ".gz" and stores the explicit URL.
  const gzipSourceUrl =
    typeof input.gzip_source_url === "string" && input.gzip_source_url
      ? input.gzip_source_url
      : input.gzip_sha256
        ? `${input.source_url}.gz`
        : null;
  try {
    const inserted = await c.env.DB
      .prepare(
        `INSERT INTO external_build_targets
         (id, app_id, build_id, version_name, target, source_url,
          raw_sha256, raw_size_bytes, gzip_sha256, gzip_size_bytes,
          node_version, metadata_json, created_at, updated_at, gzip_source_url)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
         WHERE (SELECT targets_frozen_at FROM builds WHERE id = ?16) IS NULL`,
      )
      .bind(
        targetId,
        appId,
        build.id,
        input.version_name,
        input.target,
        input.source_url,
        input.raw_sha256,
        input.raw_size_bytes,
        input.gzip_sha256 ?? null,
        input.gzip_size_bytes ?? null,
        input.node_version ?? null,
        externalJsonString(input.metadata_json),
        now,
        now,
        gzipSourceUrl,
        build.id,
      )
      .run();
    if ((inserted.meta?.changes ?? 0) === 0) {
      // Conditional insert refused: the build's target set is frozen by a
      // published release. Exact replays of an existing declaration stay
      // idempotent (CI re-runs must not fail post-publish); a mismatched
      // redeclaration is a conflict; a genuinely new target is frozen out.
      const frozenExisting = await getExternalTarget(c.env.DB, appId, input.version_name, input.target);
      if (frozenExisting) {
        if (!externalDeclarationMatches(frozenExisting, input)) {
          return c.json(
            {
              error: "external build declaration conflicts with the existing immutable target",
              code: "EXTERNAL_BUILD_CONFLICT",
              build_id: frozenExisting.build_id,
              target_id: frozenExisting.id,
              target: frozenExisting.target,
            },
            409,
          );
        }
        const { platform, arch } = splitBuildTarget(input.target);
        return c.json({
          app_id: appId,
          build_id: frozenExisting.build_id,
          target_id: frozenExisting.id,
          version: input.version_name,
          target: input.target,
          platform,
          arch,
          replayed: true,
        });
      }
      return c.json(
        {
          error: "this build's target set is frozen by a published release; no new targets may be declared",
          code: "EXTERNAL_TARGETS_FROZEN",
          build_id: build.id,
        },
        409,
      );
    }
  } catch (error) {
    const concurrent = await getExternalTarget(c.env.DB, appId, input.version_name, input.target);
    if (!concurrent) throw error;
    if (!externalDeclarationMatches(concurrent, input)) {
      return c.json(
        {
          error: "external build declaration conflicts with the existing immutable target",
          code: "EXTERNAL_BUILD_CONFLICT",
          build_id: concurrent.build_id,
          target_id: concurrent.id,
          target: concurrent.target,
        },
        409,
      );
    }
    const { platform, arch } = splitBuildTarget(input.target);
    return c.json({
      app_id: appId,
      build_id: concurrent.build_id,
      target_id: concurrent.id,
      version: input.version_name,
      target: input.target,
      platform,
      arch,
      replayed: true,
    });
  }

  await insertAuditLog(c.env.DB, appId, "external_build.publish", currentActor(c), {
    buildId: build.id,
    targetId,
    version: input.version_name,
    target: input.target,
    source_url: input.source_url,
    raw_sha256: input.raw_sha256,
    raw_size_bytes: input.raw_size_bytes,
    gzip_sha256: input.gzip_sha256 ?? null,
    gzip_size_bytes: input.gzip_size_bytes ?? null,
    node_version: input.node_version ?? null,
  });

  const { platform, arch } = splitBuildTarget(input.target);
  return c.json(
    {
      app_id: appId,
      build_id: build.id,
      target_id: targetId,
      version: input.version_name,
      target: input.target,
      platform,
      arch,
      replayed: false,
    },
    201,
  );
}

export async function handleListExternalBuildTargets(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, build_id, version_name, target, source_url,
              raw_sha256, raw_size_bytes, gzip_sha256, gzip_size_bytes,
              node_version, metadata_json, created_at, updated_at
       FROM external_build_targets
       WHERE app_id = ?1 AND build_id = ?2
       ORDER BY target ASC`,
    )
    .bind(appId, buildId)
    .all();
  return c.json({ targets: results });
}

export async function handleCreateBuild(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as BuildInput;
  try {
    const id = await createBuild(c.env.DB, appId, body, currentActor(c));
    // Emit webhook event (P2.5.8). Best-effort.
    const orgId = c.get("org_id");
    if (orgId && (body.status === "succeeded" || body.status === "failed")) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env, {
          orgId,
          appId,
          event: body.status === "succeeded" ? "build:succeeded" : "build:failed",
          body: { build_id: id, app_id: appId, version_name: body.version_name, version_code: body.version_code },
        }),
      );
    }
    return c.json({ id, app_id: appId, ...body }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

export async function handleUpdateBuild(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const body = (await c.req.json()) as {
    changelog?: string | null;
    provenance_json?: unknown;
    should_force_update?: boolean;
    availability_at?: number | null;
    status?: string;
  };
  const existing = await getBuildForApp(c.env.DB, appId, buildId);
  if (!existing) return c.json({ error: "not found" }, 404);

  if (body.status === "succeeded" && existing.asset_ingest_protocol_version === 1) {
    let required: Array<{
      artifact_kind?: string;
      platform: string;
      arch?: string | null;
      variant?: string | null;
      filetype: string;
    }>;
    try {
      required = JSON.parse(existing.required_asset_slots_json ?? "[]");
    } catch {
      return c.json({ error: "build has invalid required asset slots", code: "INVALID_REQUIRED_ASSET_SLOTS" }, 500);
    }
    if (!Array.isArray(required) || required.length === 0) {
      return c.json({ error: "build has no required asset slots", code: "REQUIRED_ASSETS_INCOMPLETE" }, 409);
    }
    for (const slot of required) {
      const ready = await c.env.DB.prepare(
        `SELECT 1 AS ready
           FROM build_assets a
           JOIN build_asset_ingest_attempt i ON i.asset_id = a.id
          WHERE a.build_id = ?1 AND a.artifact_kind = ?2 AND a.platform = ?3
            AND a.slot_arch = COALESCE(?4, '-') AND a.slot_variant = COALESCE(?5, '-')
            AND a.filetype = ?6 AND i.state = 'ready'
            AND json_extract(a.metadata_json, '$.upload_state') = 'ready'
            AND json_extract(a.metadata_json, '$.verified_sha256') = a.file_hash
            AND json_extract(a.metadata_json, '$.verified_size_bytes') = a.size_bytes
          LIMIT 1`,
      ).bind(
        buildId,
        slot.artifact_kind ?? "installable",
        slot.platform,
        slot.arch ?? null,
        slot.variant ?? null,
        slot.filetype,
      ).first<{ ready: number }>();
      if (!ready) {
        return c.json({ error: "required build assets are not verified", code: "REQUIRED_ASSETS_INCOMPLETE", slot }, 409);
      }
    }
  }

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.changelog !== undefined) {
    updates.push(`changelog = ?${binds.length + 1}`);
    binds.push(body.changelog ?? null);
  }
  if (body.provenance_json !== undefined) {
    updates.push(`provenance_json = ?${binds.length + 1}`);
    binds.push(jsonString(body.provenance_json));
  }
  if (body.should_force_update !== undefined) {
    updates.push(`should_force_update = ?${binds.length + 1}`);
    binds.push(body.should_force_update ? 1 : 0);
  }
  if (body.availability_at !== undefined) {
    updates.push(`availability_at = ?${binds.length + 1}`);
    binds.push(body.availability_at ?? null);
  }
  if (body.status !== undefined) {
    updates.push(`status = ?${binds.length + 1}`);
    binds.push(body.status);
    updates.push(`completed_at = ?${binds.length + 1}`);
    binds.push(body.status === "succeeded" || body.status === "failed" ? Date.now() : null);
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  updates.push(`updated_at = ?${binds.length + 1}`);
  binds.push(Date.now());
  binds.push(buildId, appId);
  await c.env.DB.prepare(
    `UPDATE builds SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  )
    .bind(...binds)
    .run();
  await insertAuditLog(c.env.DB, appId, "build.update", currentActor(c), { buildId, ...body });
  // Emit webhook event (P2.5.8) when status transitions to terminal.
  if (body.status === "succeeded" || body.status === "failed") {
    const orgId = c.get("org_id");
    if (orgId) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env, {
          orgId,
          appId,
          event: body.status === "succeeded" ? "build:succeeded" : "build:failed",
          body: { build_id: buildId, app_id: appId, status: body.status },
        }),
      );
    }
  }
  return c.json({ ok: true });
}

export async function handleListBuildAssets(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.build_id, a.artifact_kind, a.platform, a.arch, a.variant, a.filetype, a.r2_key,
            a.file_hash, a.size_bytes, a.signing_credential_id,
            a.metadata_json, a.download_count, a.created_at,
            i.state AS ingest_state, i.declared_sha256, i.declared_size AS declared_size_bytes,
            i.committed_final_key, i.upload_expires_at,
            json_extract(a.metadata_json, '$.verified_sha256') AS verified_sha256,
            json_extract(a.metadata_json, '$.verified_size_bytes') AS verified_size_bytes
       FROM build_assets a
       LEFT JOIN build_asset_ingest_attempt i
         ON i.asset_id = a.id
        AND i.attempt = (SELECT MAX(i2.attempt) FROM build_asset_ingest_attempt i2 WHERE i2.asset_id = a.id)
      WHERE a.build_id = ?1
      ORDER BY a.created_at ASC`,
  )
    .bind(buildId)
    .all();
  return c.json({ assets: results });
}

export async function handleCreateBuildAsset(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const body = (await c.req.json()) as BuildAssetInput;
  try {
    const id = await createBuildAsset(c.env.DB, appId, buildId, body, currentActor(c));
    // Installable package assets get parsed automatically in the background:
    // parser metadata merges into builds.parsed_metadata_json. Android APKs
    // may also register a per-version app-icon asset.
    if (
      (body.artifact_kind ?? "installable") === "installable" &&
      ((body.platform === "android" && body.filetype === "apk") ||
        (body.platform === "ios" && body.filetype === "ipa")) &&
      body.r2_key
    ) {
      const parserKind = body.platform === "ios" ? "ipa-info" : "apk-aapt";
      try {
        c.executionCtx.waitUntil(
          autoParseInstallableAsset(c.env, appId, buildId, body.r2_key, parserKind),
        );
      } catch {
        // executionCtx unavailable (tests) — parse inline, best effort.
        autoParseInstallableAsset(c.env, appId, buildId, body.r2_key, parserKind).catch(() => {});
      }
    }
    return c.json({ id, build_id: buildId, ...body }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

/**
 * Fetch an installable asset from R2, parse it in the multi-parser container,
 * merge the metadata into the build row, and register extracted Android
 * launcher icons as app-icon assets. Best-effort: failures only log.
 */
export async function autoParseInstallableAsset(
  env: Env,
  appId: string,
  buildId: string,
  r2Key: string,
  parserKind: "apk-aapt" | "ipa-info" = "apk-aapt",
): Promise<void> {
  try {
    const object = await env.APK_BUCKET.get(r2Key);
    if (!object) return;
    const bytes = await object.arrayBuffer();
    // Lazy import: @cloudflare/containers pulls in the cloudflare:workers
    // builtin, which only exists in the Workers runtime (not vitest/node).
    const { getRandom } = await import("@cloudflare/containers");
    const container = await getRandom(env.APK_PARSER, 1);
    const res = await container.fetch(
      new Request(`http://container/parse?parser_kind=${parserKind}`, {
        method: "POST",
        body: bytes,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    if (!res.ok) {
      console.error(`[auto-parse] container ${res.status} for build ${buildId}`);
      return;
    }
    const metadata = (await res.json()) as Record<string, unknown> & {
      icon_base64?: string | null;
      icon_content_type?: string | null;
    };
    const { icon_base64, icon_content_type, ...parsed } = metadata;
    const now = Date.now();
    const statements = [env.DB.prepare(
      "UPDATE builds SET parsed_metadata_json = ?1, updated_at = ?2 WHERE id = ?3",
    ).bind(JSON.stringify(parsed), now, buildId)];

    if (parserKind === "apk-aapt") {
      const asset = await env.DB.prepare(
        `SELECT ba.id, ba.file_hash, ba.size_bytes, b.version_code
         FROM build_assets ba
         JOIN builds b ON b.id=ba.build_id
         WHERE ba.build_id=?1 AND b.app_id=?2 AND ba.r2_key=?3
           AND ba.artifact_kind='installable'
           AND ba.platform='android' AND ba.filetype='apk'
         LIMIT 1`,
      ).bind(buildId, appId, r2Key).first<InstallerAssetIngestionRow>();
      if (!asset) throw new Error("exact APK asset row not found");
      const verified = verifiedApkMetadata(metadata, asset);
      if (!verified) throw new Error("APK inspector metadata does not match exact asset bytes");
      statements.push(env.DB.prepare(
        `INSERT INTO installer_asset_metadata
          (asset_id, platform, filetype, package_id, version_code,
           signer_lineages_json, inspected_file_hash, inspector_version, inspected_at)
         VALUES (?1, 'android', 'apk', ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(asset_id) DO UPDATE SET
           platform=excluded.platform,
           filetype=excluded.filetype,
           package_id=excluded.package_id,
           version_code=excluded.version_code,
           signer_lineages_json=excluded.signer_lineages_json,
           inspected_file_hash=excluded.inspected_file_hash,
           inspector_version=excluded.inspector_version,
           inspected_at=excluded.inspected_at`,
      ).bind(
        asset.id,
        verified.packageId,
        verified.versionCode,
        JSON.stringify(verified.signerLineages),
        verified.fileHash,
        APK_INSPECTOR_VERSION,
        now,
      ));
    }
    await env.DB.batch(statements);

    if (icon_base64) {
      const iconBytes = Uint8Array.from(atob(icon_base64), (ch) => ch.charCodeAt(0));
      const ext = icon_content_type === "image/webp" ? "webp" : "png";
      const iconKey = `apps/${appId}/builds/${buildId}/icon.${ext}`;
      await env.APK_BUCKET.put(iconKey, iconBytes, {
        httpMetadata: { contentType: icon_content_type ?? "image/png" },
      });
      const digest = await crypto.subtle.digest("SHA-256", iconBytes);
      const hash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM build_assets WHERE build_id = ?1 AND artifact_kind = 'app-icon'",
        ).bind(buildId),
        env.DB.prepare(
          `INSERT INTO build_assets
           (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key,
            file_hash, size_bytes, metadata_json, created_at)
           VALUES (?1, ?2, 'app-icon', 'android', NULL, NULL, ?3, ?4, ?5, ?6, '{}', ?7)`,
        ).bind(crypto.randomUUID(), buildId, ext, iconKey, hash, iconBytes.length, now),
      ]);
    }
  } catch (err) {
    console.error(
      `[auto-parse] failed for build ${buildId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleDownloadBuildAsset(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const asset = await c.env.DB.prepare(
    `SELECT ba.id, ba.artifact_kind, ba.platform, ba.arch, ba.variant, ba.filetype,
            ba.r2_key, ba.size_bytes,
            a.slug AS app_slug,
            b.version_name, b.version_code
     FROM build_assets ba
     JOIN builds b ON b.id = ba.build_id
     JOIN apps a ON a.id = b.app_id
     WHERE a.id = ?1 AND b.id = ?2 AND ba.id = ?3
     LIMIT 1`,
  )
    .bind(appId, buildId, assetId)
    .first<BuildAssetDownloadRow>();
  if (!asset) return c.json({ error: "asset not found" }, 404);

  const contentDisposition = contentDispositionForBuildAsset(asset);
  const directUrl = await presignR2DownloadUrl(c.env, {
    key: asset.r2_key,
    filetype: asset.filetype,
    contentDisposition,
  }, Number(c.env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS ?? c.env.SIGNED_URL_TTL_SECONDS ?? "3600"));
  if (c.req.query("presign") === "1") {
    const objectHead = await c.env.APK_BUCKET.head(asset.r2_key);
    if (!objectHead) return c.json({ error: "object not found" }, 404);
    // Prefer an S3-style presign when R2 S3 credentials are configured; otherwise
    // fall back to the Worker-signed /public/r2 URL (HMAC over key+expiry with
    // SIGNED_URL_SECRET — the same mechanism share-page downloads use). Both are
    // browser-navigable without an Authorization header, so the console can hand
    // a real download link to the browser even though the API is Bearer-only.
    const ttl = Number(
      c.env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS ?? c.env.SIGNED_URL_TTL_SECONDS ?? "3600",
    );
    const downloadUrl =
      directUrl ?? (await generateSignedR2Url(c.env, asset.r2_key, ttl, requestOrigin(c)));
    if (!downloadUrl) {
      return c.json({ error: "presigned downloads are unavailable" }, 503);
    }
    // Presign just hands out a link; the download itself isn't counted here.
    return c.json({
      asset_id: asset.id,
      artifact_kind: asset.artifact_kind,
      filetype: asset.filetype,
      size_bytes: asset.size_bytes,
      download_url: downloadUrl,
    });
  }
  if (directUrl) {
    const objectHead = await c.env.APK_BUCKET.head(asset.r2_key);
    if (!objectHead) return c.json({ error: "object not found" }, 404);
    await incrementBuildAssetDownloadCount(c.env.DB, assetId, buildId);
    return c.redirect(directUrl, 302);
  }

  const object = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!object) return c.json({ error: "object not found" }, 404);
  await incrementBuildAssetDownloadCount(c.env.DB, assetId, buildId);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=0, no-store");
  headers.set("content-type", contentTypeForAsset(asset.filetype));
  headers.set("content-length", String(asset.size_bytes));
  headers.set("content-disposition", contentDisposition);
  return new Response(object.body, { headers });
}

export async function handleDeleteBuildAsset(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const expectedFileHash = c.req.query("expected_file_hash")?.trim().toLowerCase() ?? null;
  const expectedSizeRaw = c.req.query("expected_size_bytes")?.trim() ?? null;
  const guardedAgentDelete = expectedFileHash !== null || expectedSizeRaw !== null;

  if (guardedAgentDelete) {
    if (!expectedFileHash || expectedSizeRaw === null) {
      return c.json(
        {
          error: "expected_file_hash and expected_size_bytes are required together",
          code: "ASSET_DELETE_PRECONDITION_REQUIRED",
        },
        400,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(expectedFileHash)) {
      return c.json({ error: "expected_file_hash must be a SHA-256 hex digest" }, 400);
    }
    if (!/^\d+$/.test(expectedSizeRaw) || !Number.isSafeInteger(Number(expectedSizeRaw))) {
      return c.json({ error: "expected_size_bytes must be a non-negative safe integer" }, 400);
    }
  }

  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const asset = await c.env.DB.prepare(
    `SELECT id, artifact_kind, r2_key, file_hash, size_bytes
     FROM build_assets
     WHERE id = ?1 AND build_id = ?2`,
  )
    .bind(assetId, buildId)
    .first<{
      id: string;
      artifact_kind: string;
      r2_key: string;
      file_hash: string;
      size_bytes: number;
    }>();
  if (!asset) {
    if (guardedAgentDelete) {
      const prior = await c.env.DB.prepare(
        `SELECT id, payload
         FROM audit_logs
         WHERE app_id = ?1 AND action = 'build_asset.delete'
           AND json_extract(payload, '$.buildId') = ?2
           AND json_extract(payload, '$.assetId') = ?3
           AND lower(json_extract(payload, '$.fileHash')) = ?4
           AND CAST(json_extract(payload, '$.sizeBytes') AS INTEGER) = ?5
           AND json_extract(payload, '$.r2Preserved') = 1
         ORDER BY created_at DESC
         LIMIT 1`,
      )
        .bind(appId, buildId, assetId, expectedFileHash, Number(expectedSizeRaw))
        .first<{ id: string; payload: string }>();
      if (!prior) {
        return c.json(
          {
            error: "asset metadata is absent without a matching successful delete audit",
            code: "ASSET_DELETE_PROVENANCE_NOT_FOUND",
            metadata_absent: true,
            r2_preserved: null,
          },
          404,
        );
      }
      let payload: {
        r2Key?: unknown;
        fileHash?: unknown;
        sizeBytes?: unknown;
      };
      try {
        payload = JSON.parse(prior.payload) as typeof payload;
      } catch {
        return c.json(
          { error: "matching delete audit is malformed", code: "ASSET_DELETE_AUDIT_INVALID" },
          500,
        );
      }
      if (
        typeof payload.r2Key !== "string" ||
        payload.fileHash !== expectedFileHash ||
        payload.sizeBytes !== Number(expectedSizeRaw)
      ) {
        return c.json(
          { error: "matching delete audit is incomplete", code: "ASSET_DELETE_AUDIT_INVALID" },
          500,
        );
      }
      let object: R2Object | null;
      try {
        object = await c.env.APK_BUCKET.head(payload.r2Key);
      } catch {
        return c.json(
          {
            error: "stored object readback is temporarily unavailable",
            code: "ASSET_OBJECT_READBACK_FAILED",
            metadata_absent: true,
            r2_preserved: null,
            audit_id: prior.id,
          },
          503,
        );
      }
      if (!object || object.size !== payload.sizeBytes) {
        return c.json(
          {
            error: "stored object from the successful delete audit is missing or changed",
            code: "ASSET_OBJECT_PRECONDITION_FAILED",
            metadata_absent: true,
            r2_preserved: false,
          },
          409,
        );
      }
      return c.json({
        ok: true,
        deleted: false,
        idempotent_replay: true,
        asset_id: assetId,
        build_id: buildId,
        metadata_absent: true,
        r2_preserved: true,
        r2_key: payload.r2Key,
        file_hash: payload.fileHash,
        size_bytes: payload.sizeBytes,
        audit_id: prior.id,
      });
    }
    return c.json({ error: "asset not found" }, 404);
  }

  if (guardedAgentDelete) {
    const expectedSize = Number(expectedSizeRaw);
    if (asset.artifact_kind === "installable") {
      return c.json(
        {
          error: "guarded Agent deletion does not allow installable assets",
          code: "INSTALLABLE_ASSET_DELETE_FORBIDDEN",
        },
        409,
      );
    }
    if (asset.file_hash.toLowerCase() !== expectedFileHash || asset.size_bytes !== expectedSize) {
      return c.json(
        {
          error: "build asset no longer matches the expected immutable bytes",
          code: "ASSET_DELETE_PRECONDITION_FAILED",
        },
        409,
      );
    }
    let object: R2Object | null;
    try {
      object = await c.env.APK_BUCKET.head(asset.r2_key);
    } catch {
      return c.json(
        {
          error: "stored object preflight is temporarily unavailable",
          code: "ASSET_OBJECT_READBACK_FAILED",
          r2_preserved: null,
        },
        503,
      );
    }
    if (!object || object.size !== asset.size_bytes) {
      return c.json(
        {
          error: "stored object is missing or its size no longer matches the asset metadata",
          code: "ASSET_OBJECT_PRECONDITION_FAILED",
        },
        409,
      );
    }
  }

  const auditId = crypto.randomUUID();
  const auditPayload = JSON.stringify({
    buildId,
    assetId,
    artifactKind: asset.artifact_kind,
    r2Key: asset.r2_key,
    fileHash: asset.file_hash.toLowerCase(),
    sizeBytes: asset.size_bytes,
    r2Preserved: true,
    guarded: guardedAgentDelete,
  });
  const now = Date.now();
  const actor = currentActor(c);
  const auditStatement = guardedAgentDelete
    ? c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, ?2, 'build_asset.delete', ?3, ?4, ?5
       FROM build_assets
       WHERE id = ?6 AND build_id = ?7 AND artifact_kind <> 'installable'
         AND lower(file_hash) = ?8 AND size_bytes = ?9
         AND artifact_kind = ?10 AND r2_key = ?11`,
    ).bind(
      auditId,
      appId,
      actor,
      auditPayload,
      now,
      assetId,
      buildId,
      expectedFileHash,
      Number(expectedSizeRaw),
      asset.artifact_kind,
      asset.r2_key,
    )
    : c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, ?2, 'build_asset.delete', ?3, ?4, ?5
       FROM build_assets
       WHERE id = ?6 AND build_id = ?7 AND artifact_kind = ?8 AND r2_key = ?9`,
    ).bind(
      auditId,
      appId,
      actor,
      auditPayload,
      now,
      assetId,
      buildId,
      asset.artifact_kind,
      asset.r2_key,
    );
  const deleteStatement = guardedAgentDelete
    ? c.env.DB.prepare(
      `DELETE FROM build_assets
       WHERE id = ?1 AND build_id = ?2 AND artifact_kind <> 'installable'
         AND lower(file_hash) = ?3 AND size_bytes = ?4
         AND artifact_kind = ?5 AND r2_key = ?6`,
    ).bind(
      assetId,
      buildId,
      expectedFileHash,
      Number(expectedSizeRaw),
      asset.artifact_kind,
      asset.r2_key,
    )
    : c.env.DB.prepare(
      `DELETE FROM build_assets
       WHERE id = ?1 AND build_id = ?2 AND artifact_kind = ?3 AND r2_key = ?4`,
    ).bind(assetId, buildId, asset.artifact_kind, asset.r2_key);
  const results = await c.env.DB.batch([auditStatement, deleteStatement]);
  const auditWrite = results[0];
  const deletion = results[1];
  if (!auditWrite || !deletion) {
    throw new Error("atomic build-asset audit/delete batch returned an incomplete result");
  }
  const audited = Number(auditWrite.meta?.changes ?? 0) === 1;
  const deleted = Number(deletion.meta?.changes ?? 0) === 1;
  if (audited !== deleted) {
    throw new Error("atomic build-asset audit/delete result mismatch");
  }
  if (!deleted) {
    return c.json(
      {
        error: "build asset changed before the guarded delete committed",
        code: "ASSET_DELETE_PRECONDITION_FAILED",
      },
      409,
    );
  }
  if (guardedAgentDelete) {
    let object: R2Object | null;
    try {
      object = await c.env.APK_BUCKET.head(asset.r2_key);
    } catch {
      return c.json(
        {
          error: "metadata was deleted and audited, but preserved object readback is temporarily unavailable",
          code: "ASSET_OBJECT_READBACK_FAILED",
          metadata_absent: true,
          r2_preserved: null,
          audit_id: auditId,
        },
        503,
      );
    }
    if (!object || object.size !== asset.size_bytes) {
      return c.json(
        {
          error: "metadata was deleted and audited, but the preserved object readback failed",
          code: "ASSET_OBJECT_READBACK_FAILED",
          metadata_absent: true,
          r2_preserved: false,
          audit_id: auditId,
        },
        503,
      );
    }
  }
  return c.json({
    ok: true,
    deleted,
    asset_id: assetId,
    build_id: buildId,
    metadata_absent: true,
    r2_preserved: true,
    r2_key: asset.r2_key,
    file_hash: asset.file_hash,
    size_bytes: asset.size_bytes,
    audit_id: auditId,
  });
}

export async function handleDeleteBuild(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "not found" }, 404);

  const assetCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM build_assets WHERE build_id = ?1",
  )
    .bind(buildId)
    .first<{ cnt: number }>();
  if ((assetCount?.cnt ?? 0) > 0) {
    return c.json({ error: `cannot delete build with ${assetCount!.cnt} asset(s)` }, 409);
  }
  const releaseCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM releases WHERE app_id = ?1 AND build_id = ?2",
  )
    .bind(appId, buildId)
    .first<{ cnt: number }>();
  if ((releaseCount?.cnt ?? 0) > 0) {
    return c.json({ error: `cannot delete build with ${releaseCount!.cnt} release(s)` }, 409);
  }

  await c.env.DB.prepare("DELETE FROM builds WHERE id = ?1 AND app_id = ?2")
    .bind(buildId, appId)
    .run();
  await insertAuditLog(c.env.DB, appId, "build.delete", currentActor(c), { buildId });
  return c.json({ ok: true });
}

async function incrementBuildAssetDownloadCount(
  db: D1Database,
  assetId: string,
  buildId: string,
) {
  await db.prepare(
    "UPDATE build_assets SET download_count = download_count + 1 WHERE id = ?1 AND build_id = ?2",
  )
    .bind(assetId, buildId)
    .run();
}

function contentDispositionForBuildAsset(asset: BuildAssetDownloadRow): string {
  const kind = asset.artifact_kind !== "installable"
    ? `-${safeFilenameSegment(asset.artifact_kind)}`
    : "";
  const platform = asset.platform ? `-${safeFilenameSegment(asset.platform)}` : "";
  const arch = asset.arch ? `-${safeFilenameSegment(asset.arch)}` : "";
  const variant = asset.variant ? `-${safeFilenameSegment(asset.variant)}` : "";
  const extension = safeFilenameSegment(asset.filetype || "bin");
  const filename = `${safeFilenameSegment(asset.app_slug)}-${safeFilenameSegment(asset.version_name)}-${asset.version_code}${kind}${platform}${arch}${variant}.${extension}`;
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function safeFilenameSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "artifact";
}

function contentTypeForAsset(filetype: string): string {
  switch (filetype) {
    case "apk":
      return "application/vnd.android.package-archive";
    case "aab":
      return "application/octet-stream";
    case "zip":
      return "application/zip";
    case "json":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
