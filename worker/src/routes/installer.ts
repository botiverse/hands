import type { Context } from "hono";
import { encodeInstallerCursor, decodeInstallerCursor } from "../lib/installer_cursor";
import type { InstallerVariables } from "../lib/installer_auth";
import {
  loadActiveReleaseCandidates,
  rolloutIncludes,
  selectBestAsset,
} from "../lib/release_resolver";
import { generateSignedR2Url } from "./public_v2";

type InstallerContext = Context<{ Bindings: Env; Variables: InstallerVariables }>;

type VisibleApp = {
  id: string;
  slug: string;
  name: string;
  platform: "android" | "ohos";
  installer_package_id: string;
  installer_publisher_name: string;
};

type InstallerAsset = {
  id: string;
  platform: string;
  arch: string | null;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  package_id: string;
  version_code: number;
  signer_lineages: string[][];
};

type InstallerAssetRow = Omit<InstallerAsset, "signer_lineages"> & {
  signer_lineages_json: string;
};

type InstallOffer = {
  releaseId: string;
  channel: string;
  version: string;
  versionCode: number;
  asset: InstallerAsset;
};

function noStore(c: InstallerContext) {
  c.header("cache-control", "no-store");
}

function appNotFound(c: InstallerContext) {
  return c.json({ error: "app not found", code: "app_not_found" }, 404);
}

function pageLimit(c: InstallerContext): number | null {
  const raw = c.req.query("limit");
  if (!raw) return 50;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value <= 100 ? value : null;
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function parseSignerLineages(value: string): string[][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return null;
  const seen = new Set<string>();
  const lineages: string[][] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 16) return null;
    const lineage: string[] = [];
    for (const fingerprint of entry) {
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
      if (seen.has(fingerprint)) return null;
      seen.add(fingerprint);
      lineage.push(fingerprint);
    }
    lineages.push(lineage);
  }
  return lineages;
}

async function visibleApp(db: D1Database, appId: string): Promise<VisibleApp | null> {
  return db.prepare(
    `SELECT id, slug, name, platform, installer_package_id, installer_publisher_name
     FROM apps
     WHERE id=?1 AND archived=0 AND public_history=1 AND installer_catalog_public=1
       AND platform IN ('android','ohos')
       AND installer_package_id IS NOT NULL AND installer_publisher_name IS NOT NULL
     LIMIT 1`,
  ).bind(appId).first<VisibleApp>();
}

async function resolveOffer(
  db: D1Database,
  accountId: string,
  app: VisibleApp,
  channelSlug: string,
): Promise<InstallOffer | null> {
  const channel = await db.prepare(
    "SELECT id, slug FROM channels WHERE app_id=?1 AND slug=?2 LIMIT 1",
  ).bind(app.id, channelSlug).first<{ id: string; slug: string }>();
  if (!channel) return null;
  const candidates = await loadActiveReleaseCandidates(db, {
    appId: app.id,
    channelId: channel.id,
  });
  const rolloutKey = `${accountId}:${app.id}:${channel.id}`;
  for (const candidate of candidates) {
    if (!rolloutIncludes(candidate.id, candidate.rollout_cohort_count, rolloutKey)) continue;
    const scope = await db.prepare(
      `SELECT 1 AS ok FROM release_scopes
       WHERE release_id=?1 AND (
         (scope_type='full' AND scope_value='all') OR
         (scope_type='platform' AND instr(',' || scope_value || ',', ',' || ?2 || ',') > 0)
       ) LIMIT 1`,
    ).bind(candidate.id, app.platform).first<{ ok: number }>();
    if (!scope) continue;
    const build = await db.prepare(
      "SELECT version_name, version_code FROM builds WHERE id=?1 AND app_id=?2 LIMIT 1",
    ).bind(candidate.build_id, app.id).first<{ version_name: string; version_code: number }>();
    if (!build) continue;
    const assets = await db.prepare(
      `SELECT ba.id, ba.platform, ba.arch, ba.filetype, ba.r2_key, ba.file_hash,
              ba.size_bytes, m.package_id, m.version_code, m.signer_lineages_json
       FROM build_assets ba
       JOIN installer_asset_metadata m ON m.asset_id=ba.id
       WHERE ba.build_id=?1 AND ba.artifact_kind='installable'
         AND ba.file_hash=m.inspected_file_hash
         AND m.package_id=?2 AND m.version_code=?3`,
    ).bind(candidate.build_id, app.installer_package_id, build.version_code)
      .all<InstallerAssetRow>();
    const verifiedAssets: InstallerAsset[] = [];
    for (const row of assets.results) {
      const signerLineages = parseSignerLineages(row.signer_lineages_json);
      if (!signerLineages) continue;
      const { signer_lineages_json: _storedLineages, ...asset } = row;
      verifiedAssets.push({ ...asset, signer_lineages: signerLineages });
    }
    const filetype = app.platform === "android" ? "apk" : "hap";
    const asset = selectBestAsset(verifiedAssets, { platform: app.platform, arch: null, filetype });
    if (!asset || asset.platform !== app.platform || asset.filetype !== filetype) continue;
    return {
      releaseId: candidate.id,
      channel: channel.slug,
      version: build.version_name,
      versionCode: build.version_code,
      asset,
    };
  }
  return null;
}

export async function handleInstallerCatalog(c: InstallerContext) {
  noStore(c);
  const limit = pageLimit(c);
  if (!limit) return c.json({ error: "invalid request", code: "invalid_request" }, 400);
  const account = c.get("installer_account");
  const after = await decodeInstallerCursor(c.env, c.req.query("cursor"), {
    kind: "catalog", account: account.id,
  });
  if (after === undefined) return c.json({ error: "invalid request", code: "invalid_request" }, 400);

  const apps: Array<{
    id: string; slug: string; name: string; publisher: string; platform: string;
    package_id: string; channels: Array<{ name: string; latest_version: string; latest_version_code: number }>;
  }> = [];
  let scanAfter = after || "";
  let exhausted = false;
  while (apps.length <= limit && !exhausted) {
    const rows = await c.env.DB.prepare(
      `SELECT id, slug, name, platform, installer_package_id, installer_publisher_name
       FROM apps
       WHERE archived=0 AND public_history=1 AND installer_catalog_public=1
         AND platform IN ('android','ohos') AND id>?1
       ORDER BY id ASC LIMIT 100`,
    ).bind(scanAfter).all<VisibleApp>();
    exhausted = rows.results.length < 100;
    for (const app of rows.results) {
      scanAfter = app.id;
      const channels = await c.env.DB.prepare(
        "SELECT slug FROM channels WHERE app_id=?1 ORDER BY slug ASC LIMIT 33",
      ).bind(app.id).all<{ slug: string }>();
      const admitted = [];
      for (const channel of channels.results.slice(0, 32)) {
        const offer = await resolveOffer(c.env.DB, account.id, app, channel.slug);
        if (offer) admitted.push({
          name: channel.slug,
          latest_version: offer.version,
          latest_version_code: offer.versionCode,
        });
      }
      if (admitted.length) apps.push({
        id: app.id,
        slug: app.slug,
        name: app.name,
        publisher: app.installer_publisher_name,
        platform: app.platform,
        package_id: app.installer_package_id,
        channels: admitted,
      });
      if (apps.length > limit) break;
    }
    if (rows.results.length === 0) exhausted = true;
  }
  const hasMore = apps.length > limit;
  if (hasMore) apps.pop();
  const nextCursor = hasMore
    ? await encodeInstallerCursor(c.env, {
      v: 1, kind: "catalog", account: account.id, after: apps[apps.length - 1]!.id,
    })
    : null;
  return c.json({ schema: "hands-installer-catalog.v1", apps, next_cursor: nextCursor });
}

async function subscriptionPage(c: InstallerContext, after: string, limit: number) {
  const account = c.get("installer_account");
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.app_id, ch.slug AS channel, s.auto_download, s.revision,
            s.created_at, s.updated_at
     FROM installer_subscriptions s
     JOIN apps a ON a.id=s.app_id AND a.archived=0 AND a.public_history=1
       AND a.installer_catalog_public=1
     JOIN channels ch ON ch.id=s.channel_id
     WHERE s.account_id=?1 AND s.deleted_at IS NULL AND s.id>?2
     ORDER BY s.id ASC LIMIT ?3`,
  ).bind(account.id, after, limit + 1).all<{
    id: string; app_id: string; channel: string; auto_download: number; revision: number;
    created_at: number; updated_at: number;
  }>();
  const hasMore = rows.results.length > limit;
  const records = rows.results.slice(0, limit).map((row) => ({
    id: row.id,
    app_id: row.app_id,
    channel: row.channel,
    auto_download: row.auto_download === 1,
    revision: row.revision,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  }));
  const nextCursor = hasMore
    ? await encodeInstallerCursor(c.env, {
      v: 1, kind: "subscriptions", account: account.id, after: records[records.length - 1]!.id,
    })
    : null;
  return { schema: "hands-installer-subscriptions.v1", subscriptions: records, next_cursor: nextCursor };
}

export async function handleInstallerSubscriptions(c: InstallerContext) {
  noStore(c);
  const limit = pageLimit(c);
  if (!limit) return c.json({ error: "invalid request", code: "invalid_request" }, 400);
  const account = c.get("installer_account");
  const after = await decodeInstallerCursor(c.env, c.req.query("cursor"), {
    kind: "subscriptions", account: account.id,
  });
  if (after === undefined) return c.json({ error: "invalid request", code: "invalid_request" }, 400);
  return c.json(await subscriptionPage(c, after || "", limit));
}

async function subscriptionTarget(c: InstallerContext) {
  const app = await visibleApp(c.env.DB, c.req.param("appId") ?? "");
  if (!app) return null;
  const offer = await resolveOffer(c.env.DB, c.get("installer_account").id, app, c.req.param("channel") ?? "");
  if (!offer) return null;
  const channel = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE app_id=?1 AND slug=?2 LIMIT 1",
  ).bind(app.id, offer.channel).first<{ id: string }>();
  return channel ? { app, offer, channelId: channel.id } : null;
}

export async function handlePutInstallerSubscription(c: InstallerContext) {
  noStore(c);
  const target = await subscriptionTarget(c);
  if (!target) return appNotFound(c);
  let body: { auto_download?: unknown; expected_revision?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  if (typeof body.auto_download !== "boolean" ||
      !(body.expected_revision === null || Number.isInteger(body.expected_revision))) {
    return c.json({ error: "invalid request", code: "invalid_request" }, 400);
  }
  const account = c.get("installer_account");
  const now = Date.now();
  if (body.expected_revision === null) {
    const result = await c.env.DB.prepare(
      `INSERT INTO installer_subscriptions
       (id, account_id, app_id, channel_id, auto_download, revision, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
       ON CONFLICT(account_id, app_id, channel_id) DO UPDATE SET
         auto_download=excluded.auto_download,
         revision=installer_subscriptions.revision+1,
         updated_at=excluded.updated_at,
         deleted_at=NULL
       WHERE installer_subscriptions.deleted_at IS NOT NULL`,
    ).bind(crypto.randomUUID(), account.id, target.app.id, target.channelId,
      body.auto_download ? 1 : 0, now).run();
    if (result.meta.changes !== 1) {
      return c.json({ error: "subscription conflict", code: "subscription_conflict" }, 409);
    }
  } else {
    const result = await c.env.DB.prepare(
      `UPDATE installer_subscriptions
       SET auto_download=?1, revision=revision+1, updated_at=?2, deleted_at=NULL
       WHERE account_id=?3 AND app_id=?4 AND channel_id=?5
         AND deleted_at IS NULL AND revision=?6`,
    ).bind(body.auto_download ? 1 : 0, now, account.id, target.app.id,
      target.channelId, body.expected_revision).run();
    if (result.meta.changes !== 1) {
      return c.json({ error: "subscription conflict", code: "subscription_conflict" }, 409);
    }
  }
  return c.json(await subscriptionPage(c, "", 100));
}

export async function handleDeleteInstallerSubscription(c: InstallerContext) {
  noStore(c);
  const target = await subscriptionTarget(c);
  if (!target) return appNotFound(c);
  let body: { expected_revision?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  if (!Number.isInteger(body.expected_revision)) {
    return c.json({ error: "invalid request", code: "invalid_request" }, 400);
  }
  const result = await c.env.DB.prepare(
    `UPDATE installer_subscriptions
     SET revision=revision+1, updated_at=?1, deleted_at=?1
     WHERE account_id=?2 AND app_id=?3 AND channel_id=?4
       AND deleted_at IS NULL AND revision=?5`,
  ).bind(Date.now(), c.get("installer_account").id, target.app.id, target.channelId,
    body.expected_revision).run();
  if (result.meta.changes !== 1) {
    return c.json({ error: "subscription conflict", code: "subscription_conflict" }, 409);
  }
  return c.json(await subscriptionPage(c, "", 100));
}

export async function handleInstallerManifest(c: InstallerContext) {
  noStore(c);
  const app = await visibleApp(c.env.DB, c.req.param("appId") ?? "");
  if (!app) return appNotFound(c);
  const offer = await resolveOffer(
    c.env.DB, c.get("installer_account").id, app, c.req.param("channel") ?? "",
  );
  if (!offer) return appNotFound(c);
  const ttlSeconds = Math.min(2 * 60 * 60, Math.max(60,
    Number(c.env.SIGNED_URL_TTL_SECONDS || "3600")));
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const downloadUrl = await generateSignedR2Url(
    c.env, offer.asset.r2_key, ttlSeconds, new URL(c.req.url).origin,
  );
  return c.json({
    schema: "hands-installer-manifest.v1",
    app: {
      slug: app.slug,
      publisher: app.installer_publisher_name,
      platform: app.platform,
      package_id: app.installer_package_id,
    },
    release: {
      id: offer.releaseId,
      channel: offer.channel,
      version: offer.version,
      version_code: offer.versionCode,
    },
    asset: {
      id: offer.asset.id,
      platform: offer.asset.platform,
      filetype: offer.asset.filetype,
      size_bytes: offer.asset.size_bytes,
      sha256: offer.asset.file_hash,
      signer_lineages: offer.asset.signer_lineages,
      download_url: downloadUrl,
      expires_at: new Date(expiresAt).toISOString(),
    },
  });
}
