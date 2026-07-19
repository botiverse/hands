import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { emitWebhookEvent } from "./webhooks";
import { generateDeltaPatchesForBuild } from "./delta";
import { requestOrigin } from "../lib/origin";
import { parseReleaseNotes, stringifyReleaseNotes, type ReleaseNotes } from "../lib/release_notes";
import { presignR2DownloadUrl } from "../lib/r2_presign";
import { generateSignedR2Url } from "./public_v2";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
import { getBuildForApp } from "./builds";

type ReleaseScopeInput = {
  scope_type: string;
  scope_value: string;
};

export interface ReleaseInput {
  build_id: string;
  channel_id?: string;
  product_type?: string;
  release_type?: string;
  status?: "draft" | "active";
  changelog?: string | null;
  release_notes?: ReleaseNotes | null;
  should_force_update?: boolean;
  rollout_cohort_count?: number | null;
  rollout_target_cohorts_json?: unknown;
  availability_at?: number | null;
  provenance_json?: unknown;
  scopes?: ReleaseScopeInput[];
}

interface ReleaseUpdateInput {
  changelog?: string | null;
  release_notes?: ReleaseNotes | null;
  should_force_update?: boolean;
  rollout_cohort_count?: number | null;
  rollout_target_cohorts_json?: unknown;
  availability_at?: number | null;
  provenance_json?: unknown;
  scopes?: ReleaseScopeInput[];
  // Hide/show this release on the public history + release-notes surfaces
  // without deleting it. Editable even on locked (superseded/cancelled)
  // releases so junk/duplicate old entries can be cleaned from the changelog.
  hidden?: boolean;
}

interface ReleaseRow {
  id: string;
  app_id: string;
  build_id: string;
  channel_id: string;
  product_type: string;
  release_type: string;
  status: string;
  is_full: number;
  superseded_by_release_id: string | null;
  rollout_cohort_count: number | null;
  rollout_target_cohorts_json: string;
  availability_at: number | null;
  should_force_update: number;
  changelog: string | null;
  provenance_json: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function jsonString(value: unknown, fallback: Record<string, unknown> | unknown[] = {}): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? fallback);
}

function normalizeScopes(scopes: ReleaseScopeInput[] | undefined): ReleaseScopeInput[] {
  const filtered = (scopes ?? []).filter((scope) => scope.scope_type && scope.scope_value);
  return filtered.length > 0 ? filtered : [{ scope_type: "full", scope_value: "all" }];
}

function isFullRelease(scopes: ReleaseScopeInput[]): number {
  const onlyScope = scopes[0];
  return scopes.length === 1 &&
    onlyScope?.scope_type === "full" &&
    onlyScope.scope_value === "all"
    ? 1
    : 0;
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

function releaseStatus(inputStatus: ReleaseInput["status"] | undefined): "draft" | "active" {
  if (!inputStatus) return "active";
  if (inputStatus !== "draft" && inputStatus !== "active") {
    throw new Error("status must be 'draft' or 'active'");
  }
  return inputStatus;
}

function inputChangelog(input: {
  changelog?: string | null;
  release_notes?: ReleaseNotes | null;
}): string | null | undefined {
  if (input.release_notes !== undefined) return stringifyReleaseNotes(input.release_notes);
  return input.changelog;
}

function withReleaseNotes<T extends { changelog?: string | null }>(
  row: T,
): T & { release_notes: ReleaseNotes | null } {
  return {
    ...row,
    release_notes: parseReleaseNotes(row.changelog ?? null),
  };
}

export async function getReleaseForApp(
  db: D1Database,
  appId: string,
  releaseId: string,
): Promise<ReleaseRow | null> {
  return await db
    .prepare("SELECT * FROM releases WHERE app_id = ?1 AND id = ?2")
    .bind(appId, releaseId)
    .first<ReleaseRow>();
}

export async function createRelease(
  db: D1Database,
  appId: string,
  input: ReleaseInput,
  actor: string,
  id = crypto.randomUUID(),
): Promise<string> {
  if (!input.build_id) throw new Error("build_id required");
  const build = await getBuildForApp(db, appId, input.build_id);
  if (!build) throw new Error("build not found");
  if (build.product_type === "ios-simulator-qa" || build.release_type === "qa") {
    throw new Error("QA-only builds cannot be attached to releases");
  }

  const channelId = input.channel_id ?? build.channel_id;
  if (!channelId) throw new Error("channel_id required");
  const channel = await db
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND id = ?2")
    .bind(appId, channelId)
    .first<{ id: string }>();
  if (!channel) throw new Error("channel_id not found for app");

  const productType = input.product_type ?? build.product_type;
  const releaseType = input.release_type ?? build.release_type;
  const status = releaseStatus(input.status);
  const scopes = normalizeScopes(input.scopes);
  const now = Date.now();
  const changelog = inputChangelog(input);

  const statements = [
    db
      .prepare(
        `INSERT INTO releases
         (id, app_id, build_id, channel_id, product_type, release_type, status,
          is_full, rollout_cohort_count, rollout_target_cohorts_json,
          availability_at, should_force_update, changelog, provenance_json,
          created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .bind(
        id,
        appId,
        input.build_id,
        channelId,
        productType,
        releaseType,
        status,
        isFullRelease(scopes),
        input.rollout_cohort_count ?? null,
        jsonString(input.rollout_target_cohorts_json, []),
        input.availability_at ?? build.availability_at ?? null,
        input.should_force_update ?? Boolean(build.should_force_update) ? 1 : 0,
        changelog === undefined ? build.changelog ?? null : changelog,
        jsonString(input.provenance_json ?? build.provenance_json),
        actor,
        now,
        now,
      ),
    ...scopes.map((scope) =>
      db
        .prepare(
          "INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(crypto.randomUUID(), id, scope.scope_type, scope.scope_value, now),
    ),
    db
      .prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(
        crypto.randomUUID(),
        appId,
        "release.create",
        actor,
        JSON.stringify({ id, ...input, status, channel_id: channelId, product_type: productType, release_type: releaseType, scopes }),
        now,
      ),
  ];

  if (status === "active") {
    statements.push(
      db
        .prepare(
          `UPDATE releases
           SET status = 'superseded', superseded_by_release_id = ?1, updated_at = ?2
           WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
             AND release_type = ?6 AND status = 'active' AND id <> ?7`,
        )
        .bind(id, now, appId, channelId, productType, releaseType, id),
    );
  }

  await db.batch(statements);
  return id;
}

async function updateReleaseFields(
  db: D1Database,
  appId: string,
  release: ReleaseRow,
  input: ReleaseUpdateInput,
  actor: string,
): Promise<ReleaseRow> {
  if (release.status === "cancelled" || release.status === "superseded") {
    // Locked releases: allow editing only display/visibility fields — the
    // changelog (e.g. reformatting an old version's notes) and `hidden` (clean
    // junk/duplicate entries out of the public history) — never the fields with
    // live rollout/scope/availability semantics.
    const editsLiveFields =
      input.should_force_update !== undefined ||
      input.rollout_cohort_count !== undefined ||
      input.rollout_target_cohorts_json !== undefined ||
      input.availability_at !== undefined ||
      input.provenance_json !== undefined ||
      input.scopes !== undefined;
    if (editsLiveFields) {
      throw new Error(
        `cannot update ${release.status} release (only the changelog and visibility may be edited)`,
      );
    }
  }
  const now = Date.now();
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (input.release_notes !== undefined) {
    sets.push(`changelog = ?${binds.length + 1}`);
    binds.push(inputChangelog(input) ?? null);
  } else if (input.changelog !== undefined) {
    sets.push(`changelog = ?${binds.length + 1}`);
    binds.push(input.changelog);
  }
  if (input.should_force_update !== undefined) {
    sets.push(`should_force_update = ?${binds.length + 1}`);
    binds.push(input.should_force_update ? 1 : 0);
  }
  if (input.rollout_cohort_count !== undefined) {
    const next = input.rollout_cohort_count;
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      throw new Error("rollout_cohort_count must be a non-negative number");
    }
    sets.push(`rollout_cohort_count = ?${binds.length + 1}`);
    binds.push(next);
  }
  if (input.rollout_target_cohorts_json !== undefined) {
    sets.push(`rollout_target_cohorts_json = ?${binds.length + 1}`);
    binds.push(jsonString(input.rollout_target_cohorts_json, []));
  }
  if (input.availability_at !== undefined) {
    sets.push(`availability_at = ?${binds.length + 1}`);
    binds.push(input.availability_at);
  }
  if (input.provenance_json !== undefined) {
    sets.push(`provenance_json = ?${binds.length + 1}`);
    binds.push(jsonString(input.provenance_json));
  }
  if (input.hidden !== undefined) {
    sets.push(`hidden = ?${binds.length + 1}`);
    binds.push(input.hidden ? 1 : 0);
  }

  const statements: D1PreparedStatement[] = [];
  if (sets.length > 0) {
    sets.push(`updated_at = ?${binds.length + 1}`);
    binds.push(now);
    statements.push(
      db
        .prepare(`UPDATE releases SET ${sets.join(", ")} WHERE id = ?${binds.length + 1} AND app_id = ?${binds.length + 2}`)
        .bind(...binds, release.id, appId),
    );
  }

  let scopes: ReleaseScopeInput[] | undefined;
  if (input.scopes !== undefined) {
    scopes = normalizeScopes(input.scopes);
    statements.push(
      db.prepare("DELETE FROM release_scopes WHERE release_id = ?1").bind(release.id),
      ...scopes.map((scope) =>
        db
          .prepare(
            "INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          )
          .bind(crypto.randomUUID(), release.id, scope.scope_type, scope.scope_value, now),
      ),
      db
        .prepare("UPDATE releases SET is_full = ?1, updated_at = ?2 WHERE id = ?3 AND app_id = ?4")
        .bind(isFullRelease(scopes), now, release.id, appId),
    );
  }

  statements.push(
    db
      .prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(
        crypto.randomUUID(),
        appId,
        "release.update",
        actor,
        JSON.stringify({ release_id: release.id, ...input, scopes }),
        now,
      ),
  );
  await db.batch(statements);
  const updated = await getReleaseForApp(db, appId, release.id);
  if (!updated) throw new Error("release not found after update");
  return updated;
}

export async function handleListReleases(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const conditions = ["r.app_id = ?1"];
  const binds: (string | number)[] = [appId];
  const status = c.req.query("status");
  const channel = c.req.query("channel");
  const productType = c.req.query("product_type");
  const releaseType = c.req.query("release_type");

  if (status) {
    conditions.push(`r.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (channel) {
    conditions.push(`(c.id = ?${binds.length + 1} OR c.slug = ?${binds.length + 2})`);
    binds.push(channel, channel);
  }
  if (productType) {
    conditions.push(`r.product_type = ?${binds.length + 1}`);
    binds.push(productType);
  }
  if (releaseType) {
    conditions.push(`r.release_type = ?${binds.length + 1}`);
    binds.push(releaseType);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT r.*, c.slug AS channel, b.version_name, b.version_code,
            rm.offered_count, rm.current_count, rm.last_checked_at
     FROM releases r
     JOIN builds b ON b.id = r.build_id
     LEFT JOIN channels c ON c.id = r.channel_id
     LEFT JOIN release_metrics rm ON rm.release_id = r.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY r.created_at DESC
     LIMIT 200`,
  )
    .bind(...binds)
    .all();
  return c.json({ releases: results.map((release) => withReleaseNotes(release as { changelog?: string | null })) });
}

export async function handleGetRelease(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const release = await c.env.DB.prepare(
    `SELECT r.*, c.slug AS channel,
            rm.offered_count, rm.current_count, rm.last_checked_at
     FROM releases r
     LEFT JOIN channels c ON c.id = r.channel_id
     LEFT JOIN release_metrics rm ON rm.release_id = r.id
     WHERE r.app_id = ?1 AND r.id = ?2`,
  )
    .bind(appId, releaseId)
    .first();
  if (!release) return c.json({ error: "not found" }, 404);

  const build = await c.env.DB.prepare(
    `SELECT b.*, c.slug AS channel
     FROM builds b
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.app_id = ?1 AND b.id = (SELECT build_id FROM releases WHERE id = ?2 AND app_id = ?3)`,
  )
    .bind(appId, releaseId, appId)
    .first();
  const { results: assets } = await c.env.DB.prepare(
    `SELECT ba.*
     FROM build_assets ba
     JOIN releases r ON r.build_id = ba.build_id
     WHERE r.app_id = ?1 AND r.id = ?2
     ORDER BY ba.created_at ASC`,
  )
    .bind(appId, releaseId)
    .all();
  const { results: scopes } = await c.env.DB.prepare(
    "SELECT id, release_id, scope_type, scope_value, created_at FROM release_scopes WHERE release_id = ?1 ORDER BY created_at ASC",
  )
    .bind(releaseId)
    .all();
  const { results: checks } = await c.env.DB.prepare(
    `SELECT id, source, run_id, run_url, verdict, cases_total, cases_passed,
            summary, reviewer, reviewed_at, created_at, updated_at
     FROM release_checks WHERE release_id = ?1 ORDER BY updated_at DESC`,
  )
    .bind(releaseId)
    .all();

  // External target declarations (Computer-CLI-style builds): full readback so
  // a consumer can enumerate and assert required targets from the release
  // itself. gzip transport is always explicitly addressable — legacy rows
  // without a stored gzip_source_url are normalized here, never guessed by
  // the consumer.
  const { results: externalTargetRows } = await c.env.DB.prepare(
    `SELECT target, source_url, gzip_source_url, raw_sha256, raw_size_bytes,
            gzip_sha256, gzip_size_bytes, node_version, metadata_json, created_at
     FROM external_build_targets
     WHERE build_id = (SELECT build_id FROM releases WHERE id = ?1 AND app_id = ?2)
     ORDER BY target`,
  )
    .bind(releaseId, appId)
    .all<{
      target: string;
      source_url: string;
      gzip_source_url: string | null;
      raw_sha256: string;
      raw_size_bytes: number;
      gzip_sha256: string | null;
      gzip_size_bytes: number | null;
      node_version: string | null;
      metadata_json: string;
      created_at: number;
    }>();
  const externalTargets = (externalTargetRows || []).map((row) => {
    let metadata: unknown = {};
    try {
      metadata = JSON.parse(row.metadata_json || "{}");
    } catch {
      metadata = {};
    }
    return {
      target: row.target,
      raw_source_url: row.source_url,
      gzip_source_url: row.gzip_source_url ?? (row.gzip_sha256 ? `${row.source_url}.gz` : null),
      raw_sha256: row.raw_sha256,
      raw_size_bytes: row.raw_size_bytes,
      gzip_sha256: row.gzip_sha256,
      gzip_size_bytes: row.gzip_size_bytes,
      node_version: row.node_version,
      metadata,
      created_at: row.created_at,
    };
  });
  let provenance: unknown = null;
  try {
    provenance = build && (build as any).provenance_json ? JSON.parse((build as any).provenance_json) : null;
  } catch {
    provenance = null;
  }

  return c.json({
    release: withReleaseNotes(release as { changelog?: string | null }),
    build,
    assets,
    scopes,
    checks,
    external_targets: externalTargets,
    external_targets_count: externalTargets.length,
    external_targets_frozen: Boolean(build && (build as any).freeze_token),
    provenance,
  });
}

// ============================================================================
// Release checks — advisory QA write-back (task #153, Hands↔Stamp)
// ============================================================================

const CHECK_VERDICTS = ["passed", "failed", "warning", "skipped"] as const;

/**
 * Upsert an advisory verification result from an external system (one row per
 * release+source; re-posting replaces that source's verdict). Advisory only —
 * publish never consults this table.
 */
export async function handleUpsertReleaseCheck(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const release = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!release) return c.json({ error: "not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    source?: string;
    run_id?: string;
    run_url?: string;
    verdict?: string;
    cases_total?: number;
    cases_passed?: number;
    summary?: string;
    reviewer?: string;
    reviewed_at?: number;
  };
  const source = (body.source ?? "").trim().slice(0, 100);
  if (!source) return c.json({ error: "source required" }, 400);
  if (!body.verdict || !(CHECK_VERDICTS as readonly string[]).includes(body.verdict)) {
    return c.json({ error: `verdict must be one of: ${CHECK_VERDICTS.join(", ")}` }, 400);
  }
  if (body.run_url !== undefined) {
    try {
      new URL(body.run_url);
    } catch {
      return c.json({ error: "run_url must be a valid URL" }, 400);
    }
  }
  const intOrNull = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;

  const now = Date.now();
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO release_checks
         (id, release_id, app_id, source, run_id, run_url, verdict,
          cases_total, cases_passed, summary, reviewer, reviewed_at,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (release_id, source) DO UPDATE SET
           run_id = excluded.run_id,
           run_url = excluded.run_url,
           verdict = excluded.verdict,
           cases_total = excluded.cases_total,
           cases_passed = excluded.cases_passed,
           summary = excluded.summary,
           reviewer = excluded.reviewer,
           reviewed_at = excluded.reviewed_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        releaseId,
        appId,
        source,
        body.run_id?.slice(0, 200) ?? null,
        body.run_url ?? null,
        body.verdict,
        intOrNull(body.cases_total),
        intOrNull(body.cases_passed),
        body.summary?.slice(0, 4000) ?? null,
        body.reviewer?.slice(0, 200) ?? null,
        intOrNull(body.reviewed_at),
        now,
        now,
      ),
    c.env.DB
      .prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(
        crypto.randomUUID(),
        appId,
        "release.check",
        currentActor(c),
        JSON.stringify({ release_id: releaseId, source, verdict: body.verdict, run_id: body.run_id ?? null }),
        now,
      ),
  ]);

  const saved = await c.env.DB.prepare(
    `SELECT id, release_id, source, run_id, run_url, verdict, cases_total,
            cases_passed, summary, reviewer, reviewed_at, created_at, updated_at
     FROM release_checks WHERE release_id = ?1 AND source = ?2`,
  )
    .bind(releaseId, source)
    .first();
  return c.json({ check: saved }, 201);
}

export async function handleListReleaseChecks(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const release = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!release) return c.json({ error: "not found" }, 404);
  const { results: checks } = await c.env.DB.prepare(
    `SELECT id, release_id, source, run_id, run_url, verdict, cases_total,
            cases_passed, summary, reviewer, reviewed_at, created_at, updated_at
     FROM release_checks WHERE release_id = ?1 ORDER BY updated_at DESC`,
  )
    .bind(releaseId)
    .all();
  return c.json({ checks });
}

/**
 * Emit `release:draft_created` for a freshly created draft — the QA/integration
 * trigger (e.g. Stamp picks it up, downloads the artifact, runs its suite, and
 * writes a release check back). The payload carries the human-stable
 * identifiers (app slug, channel slug, version) plus a presigned artifact URL
 * so a consumer can fetch the installable without a Hands credential; the
 * `download_api` path is the durable token-authenticated fallback once the
 * presigned URL expires. Best-effort: a payload-assembly failure never fails
 * the release creation.
 */
async function emitReleaseDraftCreated(
  c: AdminContext,
  appId: string,
  releaseId: string,
): Promise<void> {
  try {
    const orgId = c.get("org_id");
    if (!orgId) return;
    const row = await c.env.DB.prepare(
      `SELECT r.build_id, r.channel_id, r.product_type, r.release_type,
              a.slug AS app_slug,
              b.version_name, b.version_code,
              c.slug AS channel
       FROM releases r
       JOIN apps a ON a.id = r.app_id
       JOIN builds b ON b.id = r.build_id
       LEFT JOIN channels c ON c.id = r.channel_id
       WHERE r.app_id = ?1 AND r.id = ?2`,
    )
      .bind(appId, releaseId)
      .first<{
        build_id: string;
        channel_id: string | null;
        product_type: string;
        release_type: string;
        app_slug: string;
        version_name: string;
        version_code: number;
        channel: string | null;
      }>();
    if (!row) return;

    const asset = await c.env.DB.prepare(
      `SELECT id, filetype, r2_key, size_bytes FROM build_assets
       WHERE build_id = ?1 AND artifact_kind = 'installable'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(row.build_id)
      .first<{ id: string; filetype: string; r2_key: string; size_bytes: number | null }>();

    // Presign long enough to cover the delivery retry window (5m/30m/2h) with
    // slack for the consumer's own queueing.
    const ttl = 24 * 60 * 60;
    let downloadUrl: string | null = null;
    if (asset) {
      const filename = `${row.app_slug}-${row.version_name}-${row.version_code}.${asset.filetype}`;
      downloadUrl = await presignR2DownloadUrl(
        c.env,
        {
          key: asset.r2_key,
          filetype: asset.filetype,
          contentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
        },
        ttl,
      );
      if (!downloadUrl) {
        downloadUrl = await generateSignedR2Url(c.env, asset.r2_key, ttl, requestOrigin(c));
      }
    }

    await emitWebhookEvent(c.env.DB, {
      orgId,
      appId,
      event: "release:draft_created",
      body: {
        release_id: releaseId,
        app_id: appId,
        app_slug: row.app_slug,
        build_id: row.build_id,
        channel_id: row.channel_id,
        channel: row.channel,
        product_type: row.product_type,
        release_type: row.release_type,
        version_name: row.version_name,
        version_code: row.version_code,
        artifact: asset
          ? {
              asset_id: asset.id,
              filetype: asset.filetype,
              size_bytes: asset.size_bytes,
              download_url: downloadUrl,
              download_url_expires_at: downloadUrl ? Date.now() + ttl * 1000 : null,
              download_api: `/api/apps/${appId}/builds/${row.build_id}/assets/${asset.id}/download?presign=1`,
            }
          : null,
      },
    });
  } catch (err) {
    console.error(
      `[release:draft_created] emit failed for release ${releaseId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Draft-only creation for the agent manifest path. The server enforces draft:
 * an explicit status other than 'draft' is rejected outright (activation has
 * exactly one path — the publish endpoint, behind explicit authorization).
 */
export async function handleCreateReleaseDraft(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as ReleaseInput;
  if (body.status !== undefined && body.status !== "draft") {
    return c.json(
      { error: "this endpoint creates drafts only; use the publish action (with explicit authorization) to activate" },
      400,
    );
  }
  try {
    const draftBody: ReleaseInput = { ...body, status: "draft" };
    const id = await createRelease(c.env.DB, appId, draftBody, currentActor(c));
    c.executionCtx?.waitUntil(emitReleaseDraftCreated(c, appId, id));
    const changelog = inputChangelog(draftBody) ?? null;
    return c.json(
      {
        id,
        app_id: appId,
        status: "draft",
        ...draftBody,
        changelog,
        release_notes: parseReleaseNotes(changelog),
      },
      201,
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

export async function handleCreateRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as ReleaseInput;
  try {
    const id = await createRelease(c.env.DB, appId, body, currentActor(c));
    const status = releaseStatus(body.status);
    // release:new fires only when the release is actually live; drafts get
    // their own QA-trigger event.
    const orgId = c.get("org_id");
    if (status === "active" && orgId) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env.DB, {
          orgId,
          appId,
          event: "release:new",
          body: { release_id: id, app_id: appId, build_id: body.build_id, channel_id: body.channel_id },
        }),
      );
    } else if (status === "draft") {
      c.executionCtx?.waitUntil(emitReleaseDraftCreated(c, appId, id));
    }
    const changelog = inputChangelog(body) ?? null;
    return c.json({
      id,
      app_id: appId,
      status,
      ...body,
      changelog,
      release_notes: parseReleaseNotes(changelog),
    }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

export async function handleUpdateRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as ReleaseUpdateInput;
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  try {
    const release = await updateReleaseFields(c.env.DB, appId, existing, body, currentActor(c));
    return c.json(withReleaseNotes(release));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

// ---- External-target publish gate (task #160, Computer CLI migration) ------

function canonicalizeRequiredTargets(raw: unknown): { set: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
    return { error: "required_external_targets must be an array of target strings" };
  }
  const seen = new Set<string>();
  for (const t of raw as string[]) {
    const norm = t.trim();
    if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(norm)) {
      return { error: `unknown target format: ${t} (expected e.g. darwin-arm64)` };
    }
    if (seen.has(norm)) return { error: `duplicate target: ${norm}` };
    seen.add(norm);
  }
  return { set: [...seen].sort() };
}

function targetSetDiff(required: string[], declared: string[]): { missing: string[]; unexpected: string[] } {
  const dec = new Set(declared);
  const req = new Set(required);
  return {
    missing: required.filter((t) => !dec.has(t)),
    unexpected: declared.filter((t) => !req.has(t)),
  };
}

/**
 * Freeze + assert the external-target contract inside the publish path.
 * Every external build's target set is frozen on its first publish attempt
 * (freeze_token = random ownership; declarations are conditionally rejected
 * once frozen). cli-binary requires a caller-supplied exact expected set; a
 * failed assertion clears ONLY a freeze this attempt created. Runs on every
 * publish attempt including already-active replays — no early no-op path.
 * Returns a Response on failure, null to proceed.
 */
async function assertExternalTargetGate(
  c: AdminContext,
  release: { build_id: string },
  requiredRaw: unknown,
): Promise<Response | null> {
  const build = await c.env.DB.prepare(
    `SELECT id, source, product_type, freeze_token, required_targets_json FROM builds WHERE id = ?1`,
  )
    .bind(release.build_id)
    .first<{ id: string; source: string; product_type: string; freeze_token: string | null; required_targets_json: string | null }>();
  if (!build) return c.json({ error: "release build not found" }, 409);

  if (build.source !== "external") {
    if (requiredRaw !== undefined) {
      return c.json({ error: "required_external_targets only applies to external builds" }, 400);
    }
    return null;
  }

  let callerSet: string[] | undefined;
  if (requiredRaw !== undefined) {
    const canon = canonicalizeRequiredTargets(requiredRaw);
    if ("error" in canon) return c.json({ error: canon.error }, 400);
    callerSet = canon.set;
  }
  if (build.product_type === "cli-binary" && !callerSet && !build.freeze_token) {
    return c.json(
      { error: "required_external_targets is required when publishing a cli-binary external build" },
      400,
    );
  }

  const readDeclared = async (): Promise<string[]> => {
    const { results } = await c.env.DB.prepare(
      `SELECT target FROM external_build_targets WHERE build_id = ?1 ORDER BY target`,
    )
      .bind(build.id)
      .all<{ target: string }>();
    return (results || []).map((r) => r.target);
  };

  if (!build.freeze_token) {
    const token = crypto.randomUUID();
    const cas = await c.env.DB.prepare(
      `UPDATE builds SET freeze_token = ?1, targets_frozen_at = ?2, required_targets_json = ?3
       WHERE id = ?4 AND freeze_token IS NULL`,
    )
      .bind(token, Date.now(), JSON.stringify(callerSet ?? []), build.id)
      .run();
    if ((cas.meta?.changes ?? 0) === 1) {
      // We own the freeze; declarations are now blocked, so this read is final.
      const declared = await readDeclared();
      const required = callerSet ?? declared;
      await c.env.DB.prepare(
        `UPDATE builds SET required_targets_json = ?1 WHERE id = ?2 AND freeze_token = ?3`,
      )
        .bind(JSON.stringify(required), build.id, token)
        .run();
      const diff = targetSetDiff(required, declared);
      if (diff.missing.length > 0 || diff.unexpected.length > 0) {
        // Roll back OUR freeze only, so the build isn't locked by a failed attempt.
        await c.env.DB.prepare(
          `UPDATE builds SET freeze_token = NULL, targets_frozen_at = NULL, required_targets_json = NULL
           WHERE id = ?1 AND freeze_token = ?2`,
        )
          .bind(build.id, token)
          .run();
        return c.json(
          { error: "external target set does not match the required set", code: "EXTERNAL_TARGETS_MISMATCH", missing: diff.missing, unexpected: diff.unexpected },
          400,
        );
      }
      return null;
    }
    // Lost the freeze race — fall through to the stored-contract path.
  }

  const frozen = await c.env.DB.prepare(
    `SELECT required_targets_json FROM builds WHERE id = ?1`,
  )
    .bind(build.id)
    .first<{ required_targets_json: string | null }>();
  let stored: string[] = [];
  try {
    stored = JSON.parse(frozen?.required_targets_json ?? "[]") as string[];
  } catch {
    stored = [];
  }
  if (callerSet && (callerSet.length !== stored.length || callerSet.some((t, i) => t !== stored[i]))) {
    return c.json(
      { error: "required_external_targets differs from the frozen contract", code: "EXTERNAL_TARGETS_CONTRACT_MISMATCH", frozen: stored },
      400,
    );
  }
  const declared = await readDeclared();
  const diff = targetSetDiff(stored, declared);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    // Frozen contract violated after freeze — declarations are blocked, so
    // this indicates out-of-band mutation; fail closed.
    return c.json(
      { error: "declared targets no longer match the frozen contract", code: "EXTERNAL_TARGETS_MISMATCH", missing: diff.missing, unexpected: diff.unexpected },
      409,
    );
  }
  return null;
}

export async function handlePublishRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  // The external-target gate runs on EVERY publish attempt — including
  // already-active replays — before any no-op shortcut.
  const publishBody = (await c.req.json().catch(() => ({}))) as { required_external_targets?: unknown };
  const gateFail = await assertExternalTargetGate(c, existing, publishBody.required_external_targets);
  if (gateFail) return gateFail;
  if (existing.status === "active") return c.json(existing);
  if (existing.status !== "draft") {
    return c.json({ error: `cannot publish ${existing.status} release` }, 409);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE releases
         SET status = 'active', updated_at = ?1
         WHERE id = ?2 AND app_id = ?3 AND status = 'draft'`,
      )
      .bind(now, releaseId, appId),
    c.env.DB
      .prepare(
        `UPDATE releases
         SET status = 'superseded', superseded_by_release_id = ?1, updated_at = ?2
         WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
           AND release_type = ?6 AND status = 'active' AND id <> ?7`,
      )
      .bind(
        releaseId,
        now,
        appId,
        existing.channel_id,
        existing.product_type,
        existing.release_type,
        releaseId,
      ),
    c.env.DB
      .prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(
        crypto.randomUUID(),
        appId,
        "release.publish",
        currentActor(c),
        JSON.stringify({ release_id: releaseId, build_id: existing.build_id }),
        now,
      ),
  ]);

  const orgId = c.get("org_id");
  if (orgId) {
    c.executionCtx?.waitUntil(
      emitWebhookEvent(c.env.DB, {
        orgId,
        appId,
        event: "release:new",
        body: {
          release_id: releaseId,
          app_id: appId,
          build_id: existing.build_id,
          channel_id: existing.channel_id,
        },
      }),
    );
  }

  // Auto-generate Android delta/differential update patches for this new build
  // (task #246), gated by the per-app toggle. Runs in the background so it never
  // slows or fails the publish; the toggle is also the future paid-feature gate.
  // NOTE: waitUntil is cancelled ~seconds after the response, so for real (large)
  // APKs this won't finish — before enabling the toggle in production, move this
  // to a Cloudflare Queue (enqueue here, generate in the consumer). The manual
  // endpoint runs synchronously and is unaffected.
  const app = await c.env.DB.prepare(
    "SELECT platform, delta_updates_enabled FROM apps WHERE id = ?1",
  )
    .bind(appId)
    .first<{ platform: string; delta_updates_enabled: number }>();
  if (app?.delta_updates_enabled && app.platform === "android") {
    const actor = currentActor(c);
    const buildId = existing.build_id;
    const origin = requestOrigin(c);
    c.executionCtx?.waitUntil(
      generateDeltaPatchesForBuild(c.env, { appId, buildId, actor, origin }).then(
        (outcome) => {
          if (outcome.error) {
            console.error(`[delta] auto-generate failed for build ${buildId}: ${outcome.error}`);
          }
        },
        (e) => console.error(`[delta] auto-generate threw for build ${buildId}: ${String(e)}`),
      ),
    );
  }

  const published = await getReleaseForApp(c.env.DB, appId, releaseId);
  return c.json(published ? withReleaseNotes(published) : published);
}

export async function handleDeleteRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status === "cancelled") {
    return c.json({ ok: true, id: releaseId, status: "cancelled" });
  }
  if (existing.status === "superseded") {
    return c.json({ error: "cannot cancel superseded release" }, 409);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE releases
         SET status = 'cancelled', superseded_by_release_id = NULL, updated_at = ?1
         WHERE id = ?2 AND app_id = ?3`,
      )
      .bind(now, releaseId, appId),
    c.env.DB
      .prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(
        crypto.randomUUID(),
        appId,
        "release.cancel",
        currentActor(c),
        JSON.stringify({ release_id: releaseId, previous_status: existing.status }),
        now,
      ),
  ]);
  const orgId = c.get("org_id");
  if (orgId && existing.status === "active") {
    c.executionCtx?.waitUntil(
      emitWebhookEvent(c.env.DB, {
        orgId,
        appId,
        event: "release:cancelled",
        body: { release_id: releaseId, app_id: appId, build_id: existing.build_id },
      }),
    );
  }
  return c.json({ ok: true, id: releaseId, status: "cancelled" });
}

export async function handleRollbackRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as Partial<ReleaseInput>;
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);

  const { results: existingScopes } = await c.env.DB.prepare(
    "SELECT scope_type, scope_value FROM release_scopes WHERE release_id = ?1 ORDER BY created_at ASC",
  )
    .bind(releaseId)
    .all<ReleaseScopeInput>();
  const buildId = body.build_id ?? c.req.query("build_id") ?? existing.build_id;
  const rollbackChangelog = inputChangelog(body);
  try {
    const id = await createRelease(
      c.env.DB,
      appId,
      {
        build_id: buildId,
        channel_id: body.channel_id ?? existing.channel_id,
        product_type: body.product_type ?? existing.product_type,
        release_type: body.release_type ?? existing.release_type,
        changelog: rollbackChangelog === undefined ? existing.changelog : rollbackChangelog,
        should_force_update: body.should_force_update ?? Boolean(existing.should_force_update),
        rollout_cohort_count: body.rollout_cohort_count ?? existing.rollout_cohort_count,
        availability_at: body.availability_at ?? existing.availability_at,
        provenance_json: body.provenance_json ?? existing.provenance_json,
        scopes: body.scopes ?? existingScopes,
      },
      currentActor(c),
    );
    await insertAuditLog(c.env.DB, appId, "release.rollback", currentActor(c), {
      from_release_id: releaseId,
      new_release_id: id,
      build_id: buildId,
    });
    const orgId = c.get("org_id");
    if (orgId) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env.DB, {
          orgId,
          appId,
          event: "release:rolled_back",
          body: { release_id: id, app_id: appId, rolled_back_from: releaseId, build_id: buildId },
        }),
      );
    }
    const release = await getReleaseForApp(c.env.DB, appId, id);
    return c.json({
      id,
      app_id: appId,
      build_id: buildId,
      rolled_back_from: releaseId,
      release_notes: parseReleaseNotes(release?.changelog ?? null),
    }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

export async function handleBumpRollout(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    to?: number;
    by?: number;
    delta?: number;
  };
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  const next =
    body.to !== undefined
      ? Number(body.to)
      : (existing.rollout_cohort_count ?? 0) + Number(body.by ?? body.delta ?? 0);
  if (!Number.isFinite(next) || next < 0) {
    return c.json({ error: "rollout_cohort_count must be a non-negative number" }, 400);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE releases SET rollout_cohort_count = ?1, updated_at = ?2 WHERE id = ?3 AND app_id = ?4",
  )
    .bind(next, now, releaseId, appId)
    .run();
  await insertAuditLog(c.env.DB, appId, "release.bump_rollout", currentActor(c), {
    release_id: releaseId,
    previous: existing.rollout_cohort_count,
    next,
  }, now);
  return c.json({ ok: true, rollout_cohort_count: next });
}

export async function handleForceUpdate(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    should_force_update?: boolean;
  };
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  const next =
    body.should_force_update !== undefined
      ? body.should_force_update
      : body.enabled !== undefined
        ? body.enabled
        : !Boolean(existing.should_force_update);
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE releases SET should_force_update = ?1, updated_at = ?2 WHERE id = ?3 AND app_id = ?4",
  )
    .bind(next ? 1 : 0, now, releaseId, appId)
    .run();
  await insertAuditLog(c.env.DB, appId, "release.force_update", currentActor(c), {
    release_id: releaseId,
    should_force_update: next,
  }, now);
  return c.json({ ok: true, should_force_update: next });
}
