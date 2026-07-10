import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { emitWebhookEvent } from "./webhooks";
import { generateDeltaPatchesForBuild } from "./delta";
import { requestOrigin } from "../lib/origin";
import { parseReleaseNotes, stringifyReleaseNotes, type ReleaseNotes } from "../lib/release_notes";

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
    // Locked releases: allow editing only the changelog (display text, e.g.
    // reformatting an old version's release notes), never the fields with live
    // rollout/scope/availability semantics.
    const onlyChangelog =
      (input.changelog !== undefined ||
        input.release_notes !== undefined) &&
      input.should_force_update === undefined &&
      input.rollout_cohort_count === undefined &&
      input.rollout_target_cohorts_json === undefined &&
      input.availability_at === undefined &&
      input.provenance_json === undefined &&
      input.scopes === undefined;
    if (!onlyChangelog) {
      throw new Error(
        `cannot update ${release.status} release (only the changelog may be edited)`,
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

  return c.json({
    release: withReleaseNotes(release as { changelog?: string | null }),
    build,
    assets,
    scopes,
  });
}

export async function handleCreateRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as ReleaseInput;
  try {
    const id = await createRelease(c.env.DB, appId, body, currentActor(c));
    const status = releaseStatus(body.status);
    // Emit webhook event only when the release is actually live.
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

export async function handlePublishRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
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
