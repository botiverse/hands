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

type ReleaseVersionIdentity = {
  id: string;
  build_id: string;
  status: string;
  version_name: string;
  version_code: number;
};

export class ReleaseVersionAlreadyExistsError extends Error {
  readonly code = "RELEASE_VERSION_ALREADY_EXISTS";

  constructor(readonly existing: ReleaseVersionIdentity) {
    super(
      `release version ${existing.version_name} (${existing.version_code}) already exists as ${existing.id}`,
    );
    this.name = "ReleaseVersionAlreadyExistsError";
  }
}

const RELEASE_SCOPE_TYPES = new Set(["full", "platform", "user_cohort", "ip_range", "device_group"]);

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
  expected_revision?: number;
}

interface ReleaseRow {
  id: string;
  app_id: string;
  build_id: string;
  channel_id: string;
  product_type: string;
  release_type: string;
  status: string;
  activated_at: number | null;
  revision: number;
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

interface ExternalTargetGatePlan {
  buildId: string;
  expectedFreezeToken: string | null;
  expectedRequiredTargetsJson: string | null;
  nextFreezeToken: string;
  nextRequiredTargetsJson: string;
  requiredTargets: string[];
  freezesBuild: boolean;
}

function jsonString(value: unknown, fallback: Record<string, unknown> | unknown[] = {}): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? fallback);
}

function normalizeScopes(scopes: ReleaseScopeInput[] | undefined): ReleaseScopeInput[] {
  // An omitted scope keeps the generic release default. An explicitly supplied
  // scope list is an operator boundary: never filter invalid entries and then
  // silently widen an empty result to full rollout.
  if (scopes === undefined) return [{ scope_type: "full", scope_value: "all" }];
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("release scopes must be a non-empty array when provided");
  }
  const normalized = scopes.map((scope, index) => {
    if (!scope || typeof scope !== "object") {
      throw new Error(`release scope at index ${index} must be an object`);
    }
    const scopeType = typeof scope.scope_type === "string" ? scope.scope_type.trim() : "";
    const scopeValue = typeof scope.scope_value === "string" ? scope.scope_value.trim() : "";
    if (!scopeType || !scopeValue) {
      throw new Error(`release scope at index ${index} requires non-empty scope_type and scope_value`);
    }
    return { scope_type: scopeType, scope_value: scopeValue };
  });

  const seen = new Set<string>();
  for (const scope of normalized) {
    const key = `${scope.scope_type}\u0000${scope.scope_value}`;
    if (seen.has(key)) {
      throw new Error(`duplicate release scope: ${scope.scope_type}:${scope.scope_value}`);
    }
    seen.add(key);
  }
  return normalized.sort((left, right) => {
    const leftRank = left.scope_type === "full" ? 0 : left.scope_type === "device_group" ? 1 : 2;
    const rightRank = right.scope_type === "full" ? 0 : right.scope_type === "device_group" ? 1 : 2;
    return leftRank - rightRank || left.scope_type.localeCompare(right.scope_type) || left.scope_value.localeCompare(right.scope_value);
  });
}

function matchesPublishScopeExpectation(
  scopes: ReleaseScopeInput[],
  expectedScopes: ReleaseScopeInput[],
): boolean {
  let actual: ReleaseScopeInput[];
  try {
    actual = normalizeScopes(scopes);
  } catch {
    return false;
  }
  return actual.length === expectedScopes.length && actual.every((scope, index) =>
    scope.scope_type === expectedScopes[index]?.scope_type &&
    scope.scope_value === expectedScopes[index]?.scope_value
  );
}

function parseExpectedPublishScope(raw: unknown): ReleaseScopeInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<ReleaseScopeInput>;
  const scopeType = typeof candidate.scope_type === "string" ? candidate.scope_type.trim() : "";
  const scopeValue = typeof candidate.scope_value === "string" ? candidate.scope_value.trim() : "";
  if (!scopeType || !scopeValue || !RELEASE_SCOPE_TYPES.has(scopeType)) return null;
  if (scopeType === "full" && scopeValue !== "all") return null;
  return { scope_type: scopeType, scope_value: scopeValue };
}

function validateScopeCombination(scopes: ReleaseScopeInput[]): void {
  const fullScopes = scopes.filter(
    (scope) => scope.scope_type === "full" && scope.scope_value === "all",
  );
  if (fullScopes.length > 1) {
    throw new Error("release scopes may contain full:all only once");
  }
  if (fullScopes.length === 1) {
    const incompatible = scopes.find(
      (scope) => scope.scope_type !== "full" && scope.scope_type !== "device_group",
    );
    if (incompatible) {
      throw new Error("full:all may be combined only with device_group scopes");
    }
  }
}

function parseExpectedPublishScopes(raw: unknown): ReleaseScopeInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  try {
    const scopes = normalizeScopes(raw as ReleaseScopeInput[]);
    for (const scope of scopes) {
      if (!RELEASE_SCOPE_TYPES.has(scope.scope_type)) return null;
      if (scope.scope_type === "full" && scope.scope_value !== "all") return null;
    }
    validateScopeCombination(scopes);
    return scopes;
  } catch {
    return null;
  }
}

async function validateScopes(
  db: D1Database,
  appId: string,
  scopes: ReleaseScopeInput[] | undefined,
): Promise<ReleaseScopeInput[]> {
  const normalized = normalizeScopes(scopes);
  validateScopeCombination(normalized);
  for (const scope of normalized) {
    if (!RELEASE_SCOPE_TYPES.has(scope.scope_type)) {
      throw new Error(`unsupported release scope type: ${scope.scope_type}`);
    }
    if (scope.scope_type === "full" && scope.scope_value !== "all") {
      throw new Error("full release scope value must be 'all'");
    }
    if (scope.scope_type === "device_group") {
      const group = await db.prepare(
        "SELECT id FROM device_groups WHERE id = ?1 AND app_id = ?2",
      ).bind(scope.scope_value, appId).first<{ id: string }>();
      if (!group) throw new Error(`device group not found for app: ${scope.scope_value}`);
    }
  }
  return normalized;
}

function isFullRelease(scopes: ReleaseScopeInput[]): number {
  return scopes.some((scope) => scope.scope_type === "full" && scope.scope_value === "all") ? 1 : 0;
}

function isFullCoverage(scopes: ReleaseScopeInput[], rolloutCohortCount: number | null | undefined): boolean {
  // A full scope may carry mandatory device-group overrides. It becomes full
  // coverage only when the percentage gate is also fully open.
  return scopes.some((scope) => scope.scope_type === "full" && scope.scope_value === "all") &&
    (rolloutCohortCount === null || rolloutCohortCount === undefined || rolloutCohortCount >= 100);
}

function validateRolloutCohortCount(value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("rollout_cohort_count must be an integer from 0 to 100");
  }
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

class ReleaseRevisionConflictError extends Error {
  readonly code = "RELEASE_REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number | null,
  ) {
    super(
      currentRevision === null
        ? "release disappeared during mutation"
        : `release revision changed: expected ${expectedRevision}, current ${currentRevision}`,
    );
    this.name = "ReleaseRevisionConflictError";
  }
}

function expectedReleaseRevision(raw: unknown, currentRevision: number): number {
  if (raw === undefined) return currentRevision;
  const parsed = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!Number.isInteger(parsed) || Number(parsed) < 0) {
    throw new Error("expected_revision must be a non-negative integer");
  }
  return Number(parsed);
}

function releaseRevisionConflictResponse(
  c: AdminContext,
  expectedRevision: number,
  currentRevision: number | null,
) {
  return c.json({
    error: currentRevision === null
      ? "release disappeared during mutation"
      : "release changed before the operation completed",
    code: "RELEASE_REVISION_CONFLICT",
    expected_revision: expectedRevision,
    current_revision: currentRevision,
  }, 409);
}

async function currentReleaseRevision(
  db: D1Database,
  appId: string,
  releaseId: string,
): Promise<number | null> {
  const row = await db.prepare(
    "SELECT revision FROM releases WHERE app_id = ?1 AND id = ?2",
  ).bind(appId, releaseId).first<{ revision: number }>();
  return row?.revision ?? null;
}

async function releaseScopesForMutation(
  db: D1Database,
  releaseId: string,
): Promise<ReleaseScopeInput[]> {
  const { results } = await db.prepare(
    "SELECT scope_type, scope_value FROM release_scopes WHERE release_id = ?1 ORDER BY created_at, id",
  ).bind(releaseId).all<ReleaseScopeInput>();
  return results;
}

function conditionalReleaseAuditStatement(
  db: D1Database,
  options: {
    auditId: string;
    appId: string;
    action: string;
    actor: string;
    payload: unknown;
    now: number;
    release: ReleaseRow;
    expectedRevision: number;
    expectedScopes: ReleaseScopeInput[];
    externalTargetGate?: ExternalTargetGatePlan | null;
  },
): D1PreparedStatement {
  const binds: (string | number | null)[] = [];
  const bind = (value: string | number | null): string => {
    binds.push(value);
    return `?${binds.length}`;
  };
  const auditIdParam = bind(options.auditId);
  const appIdParam = bind(options.appId);
  const actionParam = bind(options.action);
  const actorParam = bind(options.actor);
  const payloadParam = bind(JSON.stringify(options.payload));
  const nowParam = bind(options.now);
  const releaseIdParam = bind(options.release.id);
  const revisionParam = bind(options.expectedRevision);
  const statusParam = bind(options.release.status);
  const rolloutPredicate = options.release.rollout_cohort_count === null
    ? "r.rollout_cohort_count IS NULL"
    : `r.rollout_cohort_count = ${bind(options.release.rollout_cohort_count)}`;
  const scopeCountParam = bind(options.expectedScopes.length);
  const scopePredicates = options.expectedScopes.map((scope) => {
    const typeParam = bind(scope.scope_type);
    const valueParam = bind(scope.scope_value);
    return `EXISTS (
      SELECT 1 FROM release_scopes s
      WHERE s.release_id = r.id AND s.scope_type = ${typeParam} AND s.scope_value = ${valueParam}
    )`;
  });
  let externalTargetPredicate = "";
  if (options.externalTargetGate) {
    const gate = options.externalTargetGate;
    const buildIdParam = bind(gate.buildId);
    const freezePredicate = gate.expectedFreezeToken === null
      ? "b.freeze_token IS NULL AND b.required_targets_json IS NULL AND b.targets_frozen_at IS NULL"
      : `b.freeze_token = ${bind(gate.expectedFreezeToken)} AND b.required_targets_json = ${bind(gate.expectedRequiredTargetsJson)}`;
    const targetCountParam = bind(gate.requiredTargets.length);
    const targetPredicates = gate.requiredTargets.map((target) => {
      const targetParam = bind(target);
      return `EXISTS (
        SELECT 1 FROM external_build_targets t
        WHERE t.build_id = b.id AND t.target = ${targetParam}
      )`;
    });
    externalTargetPredicate = `AND EXISTS (
         SELECT 1 FROM builds b
         WHERE b.id = r.build_id AND b.id = ${buildIdParam}
           AND ${freezePredicate}
           AND (SELECT COUNT(*) FROM external_build_targets t WHERE t.build_id = b.id) = ${targetCountParam}
           ${targetPredicates.map((predicate) => `AND ${predicate}`).join("\n           ")}
       )`;
  }

  return db.prepare(
    `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
     SELECT ${auditIdParam}, ${appIdParam}, ${actionParam}, ${actorParam}, ${payloadParam}, ${nowParam}
     FROM releases r
     WHERE r.id = ${releaseIdParam} AND r.app_id = ${appIdParam}
       AND r.revision = ${revisionParam} AND r.status = ${statusParam}
       AND ${rolloutPredicate}
       AND (SELECT COUNT(*) FROM release_scopes s WHERE s.release_id = r.id) = ${scopeCountParam}
       ${scopePredicates.map((predicate) => `AND ${predicate}`).join("\n       ")}
       ${externalTargetPredicate}`,
  ).bind(...binds);
}

async function throwReleaseMutationConflict(
  db: D1Database,
  appId: string,
  releaseId: string,
  expectedRevision: number,
): Promise<never> {
  throw new ReleaseRevisionConflictError(
    expectedRevision,
    await currentReleaseRevision(db, appId, releaseId),
  );
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

async function findReleaseForVersionIdentity(
  db: D1Database,
  appId: string,
  channelId: string,
  productType: string,
  releaseType: string,
  versionCode: number,
): Promise<ReleaseVersionIdentity | null> {
  return await db.prepare(
    `SELECT r.id, r.build_id, r.status, b.version_name, b.version_code
     FROM releases r
     JOIN builds b ON b.id = r.build_id
     WHERE r.app_id = ?1 AND r.channel_id = ?2 AND r.product_type = ?3
       AND r.release_type = ?4 AND b.version_code = ?5
     ORDER BY CASE r.status
       WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'superseded' THEN 2 ELSE 3
     END, r.created_at ASC, r.id ASC
     LIMIT 1`,
  ).bind(appId, channelId, productType, releaseType, versionCode).first<ReleaseVersionIdentity>();
}

function releaseVersionConflictResponse(c: AdminContext, error: ReleaseVersionAlreadyExistsError) {
  return c.json({
    error: error.message,
    code: error.code,
    release_id: error.existing.id,
    build_id: error.existing.build_id,
    release_status: error.existing.status,
    version_name: error.existing.version_name,
    version_code: error.existing.version_code,
  }, 409);
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
  const scopes = await validateScopes(db, appId, input.scopes);
  validateRolloutCohortCount(input.rollout_cohort_count);
  const existingVersion = await findReleaseForVersionIdentity(
    db,
    appId,
    channelId,
    productType,
    releaseType,
    build.version_code,
  );
  if (existingVersion) throw new ReleaseVersionAlreadyExistsError(existingVersion);
  const now = Date.now();
  const changelog = inputChangelog(input);

  const statements = [
    db
      .prepare(
        `INSERT INTO releases
         (id, app_id, build_id, channel_id, product_type, release_type, status,
          activated_at, is_full, rollout_cohort_count, rollout_target_cohorts_json,
          availability_at, should_force_update, changelog, provenance_json,
          created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      )
      .bind(
        id,
        appId,
        input.build_id,
        channelId,
        productType,
        releaseType,
        status,
        status === "active" ? now : null,
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

  if (status === "active" && isFullCoverage(scopes, input.rollout_cohort_count)) {
    statements.push(
      db
        .prepare(
          `UPDATE releases
           SET status = 'superseded', superseded_by_release_id = ?1,
               revision = revision + 1, updated_at = ?2
           WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
             AND release_type = ?6 AND status = 'active' AND id <> ?7`,
        )
        .bind(id, now, appId, channelId, productType, releaseType, id),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    if ((error as Error).message.includes("release version already exists")) {
      const conflict = await findReleaseForVersionIdentity(
        db,
        appId,
        channelId,
        productType,
        releaseType,
        build.version_code,
      );
      if (conflict) throw new ReleaseVersionAlreadyExistsError(conflict);
    }
    throw error;
  }
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
  const expectedRevision = expectedReleaseRevision(input.expected_revision, release.revision);
  if (expectedRevision !== release.revision) {
    throw new ReleaseRevisionConflictError(expectedRevision, release.revision);
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
    validateRolloutCohortCount(next);
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

  let scopes: ReleaseScopeInput[] | undefined;
  if (input.scopes !== undefined) {
    scopes = await validateScopes(db, appId, input.scopes);
    sets.push(`is_full = ?${binds.length + 1}`);
    binds.push(isFullRelease(scopes));
  }

  const existingScopes = await releaseScopesForMutation(db, release.id);
  const nextScopes = scopes ?? existingScopes;
  const nextRollout = input.rollout_cohort_count !== undefined
    ? input.rollout_cohort_count
    : release.rollout_cohort_count;
  const auditId = crypto.randomUUID();
  const auditPayload = {
    release_id: release.id,
    expected_revision: expectedRevision,
    ...input,
    scopes,
  };
  const statements: D1PreparedStatement[] = [
    conditionalReleaseAuditStatement(db, {
      auditId,
      appId,
      action: "release.update",
      actor,
      payload: auditPayload,
      now,
      release,
      expectedRevision,
      expectedScopes: existingScopes,
    }),
  ];

  sets.push(`updated_at = ?${binds.length + 1}`);
  binds.push(now);
  sets.push("revision = revision + 1");
  const releaseIdPosition = binds.length + 1;
  const appIdPosition = releaseIdPosition + 1;
  const revisionPosition = appIdPosition + 1;
  const statusPosition = revisionPosition + 1;
  const auditIdPosition = statusPosition + 1;
  statements.push(
    db.prepare(
      `UPDATE releases SET ${sets.join(", ")}
       WHERE id = ?${releaseIdPosition} AND app_id = ?${appIdPosition}
         AND revision = ?${revisionPosition} AND status = ?${statusPosition}
         AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?${auditIdPosition})`,
    ).bind(
      ...binds,
      release.id,
      appId,
      expectedRevision,
      release.status,
      auditId,
    ),
  );

  if (scopes !== undefined) {
    statements.push(
      db.prepare(
        `DELETE FROM release_scopes
         WHERE release_id = ?1 AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?2)`,
      ).bind(release.id, auditId),
      ...scopes.map((scope) =>
        db.prepare(
          `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE EXISTS (SELECT 1 FROM audit_logs WHERE id = ?6)`,
        ).bind(
          crypto.randomUUID(),
          release.id,
          scope.scope_type,
          scope.scope_value,
          now,
          auditId,
        )
      ),
    );
  }

  if (release.status === "active" && (input.scopes !== undefined || input.rollout_cohort_count !== undefined)) {
    if (isFullCoverage(nextScopes, nextRollout)) {
      statements.push(
        db.prepare(
          `UPDATE releases
           SET status = 'superseded', superseded_by_release_id = ?1,
               revision = revision + 1, updated_at = ?2
           WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
             AND release_type = ?6 AND status = 'active' AND id <> ?7
             AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?8)`,
        ).bind(
          release.id,
          now,
          appId,
          release.channel_id,
          release.product_type,
          release.release_type,
          release.id,
          auditId,
        ),
      );
    } else {
      // A full release may already have superseded the fallback releases when
      // it was activated. If operators narrow that active release later, put
      // only its direct victims back into the active candidate set so clients
      // outside the new scope/percentage still resolve a previous release.
      statements.push(
        db.prepare(
          `UPDATE releases
           SET status = 'active', superseded_by_release_id = NULL,
               revision = revision + 1, updated_at = ?1
           WHERE app_id = ?2 AND superseded_by_release_id = ?3 AND status = 'superseded'
             AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?4)`,
        ).bind(now, appId, release.id, auditId),
      );
    }
  }

  const batchResults = await db.batch(statements);
  if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
      Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
    await throwReleaseMutationConflict(db, appId, release.id, expectedRevision);
  }
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
            rm.offered_count, rm.current_count, rm.last_checked_at,
            (SELECT COUNT(*) FROM release_metric_devices rmd
             WHERE rmd.release_id = r.id AND rmd.metric_kind = 'offered') AS offered_uv,
            (SELECT COUNT(*) FROM release_metric_devices rmd
             WHERE rmd.release_id = r.id AND rmd.metric_kind = 'current') AS current_uv
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
            rm.offered_count, rm.current_count, rm.last_checked_at,
            (SELECT COUNT(*) FROM release_metric_devices rmd
             WHERE rmd.release_id = r.id AND rmd.metric_kind = 'offered') AS offered_uv,
            (SELECT COUNT(*) FROM release_metric_devices rmd
             WHERE rmd.release_id = r.id AND rmd.metric_kind = 'current') AS current_uv
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
        activated_at: null,
        revision: 0,
        ...draftBody,
        changelog,
        release_notes: parseReleaseNotes(changelog),
      },
      201,
    );
  } catch (e) {
    if (e instanceof ReleaseVersionAlreadyExistsError) {
      return releaseVersionConflictResponse(c, e);
    }
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
      activated_at: status === "active" ? Date.now() : null,
      revision: 0,
      ...body,
      changelog,
      release_notes: parseReleaseNotes(changelog),
    }, 201);
  } catch (e) {
    if (e instanceof ReleaseVersionAlreadyExistsError) {
      return releaseVersionConflictResponse(c, e);
    }
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
    if (e instanceof ReleaseRevisionConflictError) {
      return releaseRevisionConflictResponse(c, e.expectedRevision, e.currentRevision);
    }
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
 * Build a read-only external-target plan. The caller must commit a new freeze
 * only inside the same D1 batch as the release revision/scope transition.
 */
async function prepareExternalTargetGate(
  c: AdminContext,
  release: { build_id: string },
  requiredRaw: unknown,
): Promise<{ plan: ExternalTargetGatePlan | null } | { response: Response }> {
  const build = await c.env.DB.prepare(
    `SELECT id, source, product_type, freeze_token, required_targets_json FROM builds WHERE id = ?1`,
  )
    .bind(release.build_id)
    .first<{ id: string; source: string; product_type: string; freeze_token: string | null; required_targets_json: string | null }>();
  if (!build) return { response: c.json({ error: "release build not found" }, 409) };

  if (build.source !== "external") {
    if (requiredRaw !== undefined) {
      return { response: c.json({ error: "required_external_targets only applies to external builds" }, 400) };
    }
    return { plan: null };
  }

  let callerSet: string[] | undefined;
  if (requiredRaw !== undefined) {
    const canon = canonicalizeRequiredTargets(requiredRaw);
    if ("error" in canon) return { response: c.json({ error: canon.error }, 400) };
    callerSet = canon.set;
  }
  if (build.product_type === "cli-binary" && !callerSet && !build.freeze_token) {
    return {
      response: c.json(
        { error: "required_external_targets is required when publishing a cli-binary external build" },
        400,
      ),
    };
  }

  const { results } = await c.env.DB.prepare(
    `SELECT target FROM external_build_targets WHERE build_id = ?1 ORDER BY target`,
  )
    .bind(build.id)
    .all<{ target: string }>();
  const declared = (results || []).map((row) => row.target);

  let required: string[];
  if (build.freeze_token) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(build.required_targets_json ?? "null");
    } catch {
      parsed = null;
    }
    const canonical = canonicalizeRequiredTargets(parsed);
    if ("error" in canonical) {
      return {
        response: c.json({
          error: "frozen external target contract is invalid",
          code: "EXTERNAL_TARGETS_CONTRACT_MISMATCH",
        }, 409),
      };
    }
    required = canonical.set;
    if (callerSet && (callerSet.length !== required.length || callerSet.some((target, index) => target !== required[index]))) {
      return {
        response: c.json(
          { error: "required_external_targets differs from the frozen contract", code: "EXTERNAL_TARGETS_CONTRACT_MISMATCH", frozen: required },
          400,
        ),
      };
    }
  } else {
    required = callerSet ?? declared;
  }

  const diff = targetSetDiff(required, declared);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    return {
      response: c.json(
        {
          error: build.freeze_token
            ? "declared targets no longer match the frozen contract"
            : "external target set does not match the required set",
          code: "EXTERNAL_TARGETS_MISMATCH",
          missing: diff.missing,
          unexpected: diff.unexpected,
        },
        build.freeze_token ? 409 : 400,
      ),
    };
  }

  const nextFreezeToken = build.freeze_token ?? crypto.randomUUID();
  return {
    plan: {
      buildId: build.id,
      expectedFreezeToken: build.freeze_token,
      expectedRequiredTargetsJson: build.required_targets_json,
      nextFreezeToken,
      nextRequiredTargetsJson: build.freeze_token
        ? build.required_targets_json ?? "[]"
        : JSON.stringify(required),
      requiredTargets: required,
      freezesBuild: build.freeze_token === null,
    },
  };
}

function externalTargetFreezeStatement(
  db: D1Database,
  plan: ExternalTargetGatePlan,
  auditId: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE builds
     SET freeze_token = ?1, targets_frozen_at = ?2, required_targets_json = ?3
     WHERE id = ?4 AND freeze_token IS NULL
       AND required_targets_json IS NULL AND targets_frozen_at IS NULL
       AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?5)`,
  ).bind(
    plan.nextFreezeToken,
    now,
    plan.nextRequiredTargetsJson,
    plan.buildId,
    auditId,
  );
}

export async function handlePublishRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  const publishBody = (await c.req.json().catch(() => ({}))) as {
    required_external_targets?: unknown;
    expected_scope?: unknown;
    expected_scopes?: unknown;
    expected_revision?: unknown;
  };
  let expectedRevision: number;
  try {
    expectedRevision = expectedReleaseRevision(publishBody.expected_revision, existing.revision);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (expectedRevision !== existing.revision) {
    return releaseRevisionConflictResponse(c, expectedRevision, existing.revision);
  }

  const hasExpectedScope = Object.prototype.hasOwnProperty.call(publishBody, "expected_scope");
  const hasExpectedScopes = Object.prototype.hasOwnProperty.call(publishBody, "expected_scopes");
  if (hasExpectedScope && hasExpectedScopes) {
    return c.json({
      error: "provide expected_scope or expected_scopes, not both",
      code: "RELEASE_SCOPE_PRECONDITION_FAILED",
    }, 409);
  }

  let expectedScopes: ReleaseScopeInput[];
  if (hasExpectedScopes) {
    const parsed = parseExpectedPublishScopes(publishBody.expected_scopes);
    if (!parsed) {
      return c.json({
        error: "expected_scopes must be a valid non-empty exact release scope set",
        code: "RELEASE_SCOPE_PRECONDITION_FAILED",
      }, 409);
    }
    expectedScopes = parsed;
  } else if (hasExpectedScope) {
    const parsed = parseExpectedPublishScope(publishBody.expected_scope);
    if (!parsed) {
      return c.json({
        error: "expected_scope must contain a supported non-empty scope_type and scope_value",
        code: "RELEASE_SCOPE_PRECONDITION_FAILED",
      }, 409);
    }
    expectedScopes = [parsed];
  } else {
    expectedScopes = [{ scope_type: "full", scope_value: "all" }];
  }

  const { results: releaseScopes } = await c.env.DB.prepare(
    "SELECT scope_type, scope_value FROM release_scopes WHERE release_id = ?1 ORDER BY created_at, id",
  ).bind(releaseId).all<ReleaseScopeInput>();
  if (!matchesPublishScopeExpectation(releaseScopes, expectedScopes)) {
    return c.json({
      error: hasExpectedScope || hasExpectedScopes
        ? "release scope set does not exactly match the publish precondition"
        : "publish without a scope precondition requires exactly one full:all scope",
      code: "RELEASE_SCOPE_PRECONDITION_FAILED",
    }, 409);
  }
  if (existing.status !== "draft" && existing.status !== "active") {
    return c.json({ error: `cannot publish ${existing.status} release` }, 409);
  }

  const targetGateResult = await prepareExternalTargetGate(
    c,
    existing,
    publishBody.required_external_targets,
  );
  if ("response" in targetGateResult) return targetGateResult.response;
  const externalTargetGate = targetGateResult.plan;

  if (existing.status === "active") {
    if (externalTargetGate?.freezesBuild) {
      const now = Date.now();
      const auditId = crypto.randomUUID();
      const batchResults = await c.env.DB.batch([
        conditionalReleaseAuditStatement(c.env.DB, {
          auditId,
          appId,
          action: "release.external_targets_freeze",
          actor: currentActor(c),
          payload: {
            release_id: releaseId,
            build_id: existing.build_id,
            expected_revision: expectedRevision,
            expected_scopes: expectedScopes,
          },
          now,
          release: existing,
          expectedRevision,
          expectedScopes,
          externalTargetGate,
        }),
        externalTargetFreezeStatement(c.env.DB, externalTargetGate, auditId, now),
      ]);
      if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
          Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
        const currentRevision = await currentReleaseRevision(c.env.DB, appId, releaseId);
        if (currentRevision !== expectedRevision) {
          return releaseRevisionConflictResponse(c, expectedRevision, currentRevision);
        }
        return c.json({
          error: "external target contract changed before freeze",
          code: "EXTERNAL_TARGETS_CONTRACT_MISMATCH",
        }, 409);
      }
    }
    const active = await getReleaseForApp(c.env.DB, appId, releaseId);
    return c.json(withReleaseNotes(active ?? existing));
  }

  const now = Date.now();
  const auditId = crypto.randomUUID();
  const auditPayload = {
    release_id: releaseId,
    build_id: existing.build_id,
    expected_revision: expectedRevision,
    expected_scopes: expectedScopes,
    required_external_targets: externalTargetGate?.requiredTargets,
  };

  // D1 batch is transactional. Every side effect is gated by the conditional
  // audit insert, whose SELECT re-checks draft state, exact stored scopes, and
  // the external target/freeze precondition. A stale preflight read therefore
  // becomes a clean 409 with zero freeze, audit, fallback, or activation.
  const statements: D1PreparedStatement[] = [
    conditionalReleaseAuditStatement(c.env.DB, {
      auditId,
      appId,
      action: "release.publish",
      actor: currentActor(c),
      payload: auditPayload,
      now,
      release: existing,
      expectedRevision,
      expectedScopes,
      externalTargetGate,
    }),
  ];
  let freezeResultIndex: number | null = null;
  if (externalTargetGate?.freezesBuild) {
    freezeResultIndex = statements.length;
    statements.push(externalTargetFreezeStatement(c.env.DB, externalTargetGate, auditId, now));
  }
  statements.push(
    c.env.DB
      .prepare(
        `UPDATE releases
         SET status = 'superseded', superseded_by_release_id = ?1,
             revision = revision + 1, updated_at = ?2
         WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
           AND release_type = ?6 AND status = 'active' AND id <> ?1
           AND EXISTS (
             SELECT 1 FROM releases next
             WHERE next.id = ?1 AND next.app_id = ?3 AND next.status = 'draft'
               AND (next.rollout_cohort_count IS NULL OR next.rollout_cohort_count >= 100)
               AND EXISTS (
                 SELECT 1 FROM release_scopes s
                 WHERE s.release_id = next.id AND s.scope_type = 'full' AND s.scope_value = 'all'
               )
               AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.id = ?7)
           )`,
      )
      .bind(
        releaseId,
        now,
        appId,
        existing.channel_id,
        existing.product_type,
        existing.release_type,
        auditId,
      ),
  );
  const activationResultIndex = statements.length;
  statements.push(
    c.env.DB
      .prepare(
         `UPDATE releases
         SET status = 'active', activated_at = ?1,
             revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND app_id = ?3 AND status = 'draft' AND revision = ?4
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?5)`,
      )
      .bind(now, releaseId, appId, expectedRevision, auditId),
  );
  const batchResults = await c.env.DB.batch(statements);
  if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
      Number(batchResults[activationResultIndex]?.meta?.changes ?? 0) !== 1 ||
      (freezeResultIndex !== null && Number(batchResults[freezeResultIndex]?.meta?.changes ?? 0) !== 1)) {
    const currentRevision = await currentReleaseRevision(c.env.DB, appId, releaseId);
    if (currentRevision !== expectedRevision) {
      return releaseRevisionConflictResponse(c, expectedRevision, currentRevision);
    }
    const currentScopes = await releaseScopesForMutation(c.env.DB, releaseId);
    if (!matchesPublishScopeExpectation(currentScopes, expectedScopes)) {
      return c.json({
        error: "release status or scope changed before publish",
        code: "RELEASE_SCOPE_PRECONDITION_FAILED",
      }, 409);
    }
    if (externalTargetGate) {
      return c.json({
        error: "external target contract changed before publish",
        code: "EXTERNAL_TARGETS_CONTRACT_MISMATCH",
      }, 409);
    }
    return releaseRevisionConflictResponse(c, expectedRevision, currentRevision);
  }

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
  let expectedRevision: number;
  try {
    expectedRevision = expectedReleaseRevision(
      c.req.query("expected_revision"),
      existing.revision,
    );
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (expectedRevision !== existing.revision) {
    return releaseRevisionConflictResponse(c, expectedRevision, existing.revision);
  }
  if (existing.status === "cancelled") {
    return c.json({
      ok: true,
      id: releaseId,
      status: "cancelled",
      revision: existing.revision,
    });
  }
  if (existing.status === "superseded") {
    return c.json({ error: "cannot cancel superseded release" }, 409);
  }
  const now = Date.now();
  const auditId = crypto.randomUUID();
  const existingScopes = await releaseScopesForMutation(c.env.DB, releaseId);
  const statements: D1PreparedStatement[] = [
    conditionalReleaseAuditStatement(c.env.DB, {
      auditId,
      appId,
      action: "release.cancel",
      actor: currentActor(c),
      payload: {
        release_id: releaseId,
        previous_status: existing.status,
        expected_revision: expectedRevision,
      },
      now,
      release: existing,
      expectedRevision,
      expectedScopes: existingScopes,
    }),
    c.env.DB
      .prepare(
        `UPDATE releases
         SET status = 'cancelled', superseded_by_release_id = NULL,
             revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND app_id = ?3 AND revision = ?4 AND status = ?5
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?6)`,
      )
      .bind(now, releaseId, appId, expectedRevision, existing.status, auditId),
  ];
  if (existing.status === "active") {
    statements.push(
      c.env.DB.prepare(
        `UPDATE releases
         SET status = 'active', superseded_by_release_id = NULL,
             revision = revision + 1, updated_at = ?1
         WHERE app_id = ?2 AND superseded_by_release_id = ?3 AND status = 'superseded'
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?4)`,
      ).bind(now, appId, releaseId, auditId),
    );
  }
  const batchResults = await c.env.DB.batch(statements);
  if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
      Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
    return releaseRevisionConflictResponse(
      c,
      expectedRevision,
      await currentReleaseRevision(c.env.DB, appId, releaseId),
    );
  }
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
  return c.json({
    ok: true,
    id: releaseId,
    status: "cancelled",
    revision: expectedRevision + 1,
  });
}

export async function handleRollbackRelease(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as Partial<ReleaseInput> & {
    expected_revision?: unknown;
  };
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  let expectedRevision: number;
  try {
    expectedRevision = expectedReleaseRevision(body.expected_revision, existing.revision);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (expectedRevision !== existing.revision) {
    return releaseRevisionConflictResponse(c, expectedRevision, existing.revision);
  }
  if (existing.status === "draft") {
    return c.json({ error: "cannot restore a draft; publish the existing release instead" }, 409);
  }
  if (existing.status === "active") {
    return c.json({ error: "release is already active" }, 409);
  }

  const existingScopes = await releaseScopesForMutation(c.env.DB, releaseId);
  const requestedBuildId = body.build_id ?? c.req.query("build_id");
  if (requestedBuildId && requestedBuildId !== existing.build_id) {
    return c.json({
      error: "rollback reactivates one existing release; address the release for the requested build instead",
      code: "ROLLBACK_RELEASE_ID_REQUIRED",
      release_id: releaseId,
      build_id: existing.build_id,
    }, 409);
  }
  for (const [field, requested, stored] of [
    ["channel_id", body.channel_id, existing.channel_id],
    ["product_type", body.product_type, existing.product_type],
    ["release_type", body.release_type, existing.release_type],
  ] as const) {
    if (requested !== undefined && requested !== stored) {
      return c.json({ error: `rollback cannot change ${field} on an existing release` }, 400);
    }
  }

  try {
    const scopes = body.scopes !== undefined
      ? await validateScopes(c.env.DB, appId, body.scopes)
      : normalizeScopes(existingScopes);
    const rollout = body.rollout_cohort_count !== undefined
      ? body.rollout_cohort_count
      : existing.rollout_cohort_count;
    validateRolloutCohortCount(rollout);
    const changelog = inputChangelog(body);
    const now = Date.now();
    const restoresDraft = existing.status === "cancelled" && existing.activated_at === null;
    const nextStatus = restoresDraft ? "draft" : "active";
    const auditId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      conditionalReleaseAuditStatement(c.env.DB, {
        auditId,
        appId,
        action: "release.rollback",
        actor: currentActor(c),
        payload: {
          release_id: releaseId,
          build_id: existing.build_id,
          previous_status: existing.status,
          next_status: nextStatus,
          expected_revision: expectedRevision,
          scopes,
        },
        now,
        release: existing,
        expectedRevision,
        expectedScopes: existingScopes,
      }),
      c.env.DB.prepare(
        `UPDATE releases
         SET status = ?1, activated_at = ?2, is_full = ?3,
             rollout_cohort_count = ?4, availability_at = ?5,
             should_force_update = ?6, changelog = ?7, provenance_json = ?8,
             superseded_by_release_id = NULL, revision = revision + 1, updated_at = ?9
         WHERE id = ?10 AND app_id = ?11 AND revision = ?12 AND status = ?13
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?14)`,
      ).bind(
        nextStatus,
        restoresDraft ? null : now,
        isFullRelease(scopes),
        rollout,
        body.availability_at !== undefined ? body.availability_at : existing.availability_at,
        body.should_force_update !== undefined ? (body.should_force_update ? 1 : 0) : existing.should_force_update,
        changelog === undefined ? existing.changelog : changelog,
        jsonString(body.provenance_json ?? existing.provenance_json),
        now,
        releaseId,
        appId,
        expectedRevision,
        existing.status,
        auditId,
      ),
    ];

    if (!restoresDraft && isFullCoverage(scopes, rollout)) {
      statements.push(c.env.DB.prepare(
        `UPDATE releases
         SET status = 'superseded', superseded_by_release_id = ?1,
             revision = revision + 1, updated_at = ?2
         WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
           AND release_type = ?6 AND status = 'active' AND id <> ?1
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?7)`,
      ).bind(
        releaseId,
        now,
        appId,
        existing.channel_id,
        existing.product_type,
        existing.release_type,
        auditId,
      ));
    } else if (!restoresDraft) {
      statements.push(c.env.DB.prepare(
        `UPDATE releases
         SET status = 'active', superseded_by_release_id = NULL,
             revision = revision + 1, updated_at = ?1
         WHERE app_id = ?2 AND superseded_by_release_id = ?3 AND status = 'superseded'
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?4)`,
      ).bind(now, appId, releaseId, auditId));
    }

    if (body.scopes !== undefined) {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM release_scopes
           WHERE release_id = ?1 AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?2)`,
        ).bind(releaseId, auditId),
        ...scopes.map((scope) => c.env.DB.prepare(
          `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE EXISTS (SELECT 1 FROM audit_logs WHERE id = ?6)`,
        ).bind(crypto.randomUUID(), releaseId, scope.scope_type, scope.scope_value, now, auditId)),
      );
    }
    const batchResults = await c.env.DB.batch(statements);
    if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
        Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
      return releaseRevisionConflictResponse(
        c,
        expectedRevision,
        await currentReleaseRevision(c.env.DB, appId, releaseId),
      );
    }

    const orgId = c.get("org_id");
    if (orgId && !restoresDraft) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env.DB, {
          orgId,
          appId,
          event: "release:rolled_back",
          body: { release_id: releaseId, app_id: appId, reactivated: true, build_id: existing.build_id },
        }),
      );
    }
    const release = await getReleaseForApp(c.env.DB, appId, releaseId);
    return c.json(release ? {
      ...withReleaseNotes(release),
      restored_to_draft: restoresDraft,
      reactivated: !restoresDraft,
    } : release);
  } catch (e) {
    if (e instanceof ReleaseRevisionConflictError) {
      return releaseRevisionConflictResponse(c, e.expectedRevision, e.currentRevision);
    }
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
    expected_revision?: unknown;
  };
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  let expectedRevision: number;
  try {
    expectedRevision = expectedReleaseRevision(body.expected_revision, existing.revision);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (expectedRevision !== existing.revision) {
    return releaseRevisionConflictResponse(c, expectedRevision, existing.revision);
  }
  if (existing.status !== "draft" && existing.status !== "active") {
    return c.json({ error: `cannot change rollout on ${existing.status} release` }, 409);
  }
  const next =
    body.to !== undefined
      ? Number(body.to)
      : (existing.rollout_cohort_count ?? 0) + Number(body.by ?? body.delta ?? 0);
  try {
    validateRolloutCohortCount(next);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  const now = Date.now();
  const scopes = await releaseScopesForMutation(c.env.DB, releaseId);
  const auditId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    conditionalReleaseAuditStatement(c.env.DB, {
      auditId,
      appId,
      action: "release.bump_rollout",
      actor: currentActor(c),
      payload: {
        release_id: releaseId,
        previous: existing.rollout_cohort_count,
        next,
        expected_revision: expectedRevision,
      },
      now,
      release: existing,
      expectedRevision,
      expectedScopes: scopes,
    }),
    c.env.DB.prepare(
      `UPDATE releases
       SET rollout_cohort_count = ?1, revision = revision + 1, updated_at = ?2
       WHERE id = ?3 AND app_id = ?4 AND revision = ?5 AND status = ?6
         AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?7)`,
    ).bind(next, now, releaseId, appId, expectedRevision, existing.status, auditId),
  ];
  if (existing.status === "active") {
    if (isFullCoverage(scopes, next)) {
      statements.push(c.env.DB.prepare(
        `UPDATE releases
         SET status = 'superseded', superseded_by_release_id = ?1,
             revision = revision + 1, updated_at = ?2
         WHERE app_id = ?3 AND channel_id = ?4 AND product_type = ?5
           AND release_type = ?6 AND status = 'active' AND id <> ?1
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?7)`,
      ).bind(
        releaseId,
        now,
        appId,
        existing.channel_id,
        existing.product_type,
        existing.release_type,
        auditId,
      ));
    } else {
      statements.push(c.env.DB.prepare(
        `UPDATE releases
         SET status = 'active', superseded_by_release_id = NULL,
             revision = revision + 1, updated_at = ?1
         WHERE app_id = ?2 AND superseded_by_release_id = ?3 AND status = 'superseded'
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?4)`,
      ).bind(now, appId, releaseId, auditId));
    }
  }
  const batchResults = await c.env.DB.batch(statements);
  if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
      Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
    return releaseRevisionConflictResponse(
      c,
      expectedRevision,
      await currentReleaseRevision(c.env.DB, appId, releaseId),
    );
  }
  return c.json({
    ok: true,
    rollout_cohort_count: next,
    revision: expectedRevision + 1,
  });
}

export async function handleForceUpdate(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    should_force_update?: boolean;
    expected_revision?: unknown;
  };
  const existing = await getReleaseForApp(c.env.DB, appId, releaseId);
  if (!existing) return c.json({ error: "not found" }, 404);
  let expectedRevision: number;
  try {
    expectedRevision = expectedReleaseRevision(body.expected_revision, existing.revision);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (expectedRevision !== existing.revision) {
    return releaseRevisionConflictResponse(c, expectedRevision, existing.revision);
  }
  const next =
    body.should_force_update !== undefined
      ? body.should_force_update
      : body.enabled !== undefined
        ? body.enabled
        : !Boolean(existing.should_force_update);
  const now = Date.now();
  const auditId = crypto.randomUUID();
  const scopes = await releaseScopesForMutation(c.env.DB, releaseId);
  const batchResults = await c.env.DB.batch([
    conditionalReleaseAuditStatement(c.env.DB, {
      auditId,
      appId,
      action: "release.force_update",
      actor: currentActor(c),
      payload: {
        release_id: releaseId,
        should_force_update: next,
        expected_revision: expectedRevision,
      },
      now,
      release: existing,
      expectedRevision,
      expectedScopes: scopes,
    }),
    c.env.DB.prepare(
      `UPDATE releases
       SET should_force_update = ?1, revision = revision + 1, updated_at = ?2
       WHERE id = ?3 AND app_id = ?4 AND revision = ?5 AND status = ?6
         AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?7)`,
    ).bind(
      next ? 1 : 0,
      now,
      releaseId,
      appId,
      expectedRevision,
      existing.status,
      auditId,
    ),
  ]);
  if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1 ||
      Number(batchResults[1]?.meta?.changes ?? 0) !== 1) {
    return releaseRevisionConflictResponse(
      c,
      expectedRevision,
      await currentReleaseRevision(c.env.DB, appId, releaseId),
    );
  }
  return c.json({
    ok: true,
    should_force_update: next,
    revision: expectedRevision + 1,
  });
}
