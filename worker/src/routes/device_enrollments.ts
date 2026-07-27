import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

type DeviceEnrollmentRow = {
  id: string;
  app_id: string;
  alias: string;
  label: string | null;
  current_device_id: string | null;
  status: "active" | "revoked";
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  last_rebound_at: number | null;
  revoked_at: number | null;
};

type DeviceEnrollmentOperationRow = {
  id: string;
  app_id: string;
  enrollment_id: string;
  operation_id: string;
  kind: "create" | "rebind" | "revoke";
  from_device_id: string | null;
  to_device_id: string | null;
  expected_revision: number | null;
  resulting_revision: number;
  migrated_group_memberships: number;
  migrated_feature_flags: number;
  actor: string;
  created_at: number;
};

type EnrollmentContext = Context<{ Bindings: Env }>;

const ENROLLMENT_SELECT = `SELECT id, app_id, alias, label, current_device_id,
       status, revision, created_by, updated_by, created_at, updated_at,
       last_rebound_at, revoked_at
  FROM device_enrollments`;

const OPERATION_SELECT = `SELECT id, app_id, enrollment_id, operation_id, kind,
       from_device_id, to_device_id, expected_revision, resulting_revision,
       migrated_group_memberships, migrated_feature_flags, actor, created_at
  FROM device_enrollment_operations`;

function normalizeAlias(value: unknown): string {
  const alias = String(value ?? "").trim();
  if (!alias) throw new Error("alias required");
  if (alias.length > 80) throw new Error("alias too long (max 80 chars)");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    throw new Error("alias must use letters, numbers, dot, underscore, or hyphen");
  }
  return alias;
}

function normalizeLabel(value: unknown): string | null {
  const label = String(value ?? "").trim();
  if (label.length > 120) throw new Error("label too long (max 120 chars)");
  return label || null;
}

function normalizeDeviceId(value: unknown): string {
  const deviceId = String(value ?? "").trim();
  if (!deviceId) throw new Error("device_id required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new Error("device_id must be a Hands random per-install UUID");
  }
  return deviceId.toLowerCase();
}

function normalizeOperationId(value: unknown): string {
  const operationId = String(value ?? "").trim();
  if (!operationId) throw new Error("operation_id required");
  if (operationId.length > 128) throw new Error("operation_id too long (max 128 chars)");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)) {
    throw new Error("operation_id contains unsupported characters");
  }
  return operationId;
}

function normalizeExpectedRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("expected_revision must be a positive integer");
  }
  return revision;
}

async function getEnrollment(db: D1Database, appId: string, enrollmentId: string) {
  return db.prepare(`${ENROLLMENT_SELECT} WHERE id = ?1 AND app_id = ?2`)
    .bind(enrollmentId, appId)
    .first<DeviceEnrollmentRow>();
}

async function getOperation(db: D1Database, appId: string, operationId: string) {
  return db.prepare(`${OPERATION_SELECT} WHERE app_id = ?1 AND operation_id = ?2`)
    .bind(appId, operationId)
    .first<DeviceEnrollmentOperationRow>();
}

async function requireAndroidApp(c: EnrollmentContext, appId: string): Promise<Response | null> {
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ platform: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);
  if (app.platform !== "android") {
    return c.json({ error: "device enrollments are only supported for Android apps" }, 400);
  }
  return null;
}

function operationMatches(
  operation: DeviceEnrollmentOperationRow,
  enrollmentId: string,
  kind: "rebind" | "revoke",
  expectedRevision: number,
  toDeviceId: string | null,
): boolean {
  return operation.enrollment_id === enrollmentId &&
    operation.kind === kind &&
    operation.expected_revision === expectedRevision &&
    operation.to_device_id === toDeviceId;
}

async function createOperationMatches(
  db: D1Database,
  operation: DeviceEnrollmentOperationRow,
  alias: string,
  label: string | null,
  deviceId: string,
): Promise<boolean> {
  if (operation.kind !== "create" || operation.from_device_id !== null ||
      operation.to_device_id !== deviceId || operation.expected_revision !== null ||
      operation.resulting_revision !== 1) return false;
  const enrollment = await getEnrollment(db, operation.app_id, operation.enrollment_id);
  return enrollment?.alias === alias && enrollment.label === label;
}

async function operationResponse(
  c: EnrollmentContext,
  enrollmentId: string,
  operation: DeviceEnrollmentOperationRow,
  replayed: boolean,
) {
  const enrollment = await getEnrollment(c.env.DB, operation.app_id, enrollmentId);
  return c.json({ enrollment, operation, replayed });
}

function jsonArrayReplaceSql(column: "allow_device_ids" | "deny_device_ids"): string {
  return `(SELECT COALESCE(json_group_array(next_value), '[]')
    FROM (
      SELECT next_value
      FROM (
        SELECT CASE WHEN value = ?1 THEN ?2 ELSE value END AS next_value,
               MIN(CAST(key AS INTEGER)) AS first_position
        FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END)
        WHERE type = 'text'
        GROUP BY next_value
      )
      ORDER BY first_position
    ))`;
}

function jsonArrayRemoveSql(column: "allow_device_ids" | "deny_device_ids"): string {
  return `(SELECT COALESCE(json_group_array(value), '[]')
    FROM (
      SELECT value, MIN(CAST(key AS INTEGER)) AS first_position
      FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END)
      WHERE type = 'text' AND value <> ?1
      GROUP BY value
      ORDER BY first_position
    ))`;
}

function flagReferencesDeviceSql(devicePlaceholder = "?1"): string {
  return `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(allow_device_ids) THEN allow_device_ids ELSE '[]' END) WHERE type = 'text' AND value = ${devicePlaceholder})
      OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(deny_device_ids) THEN deny_device_ids ELSE '[]' END) WHERE type = 'text' AND value = ${devicePlaceholder})`;
}

function mapMutationError(message: string): { status: 400 | 409; error: string } {
  if (message.includes("device enrollment rebind precondition failed") ||
      message.includes("device enrollment revoke precondition failed")) {
    return { status: 409, error: "device enrollment revision/status changed; refresh and retry" };
  }
  if (message.includes("idx_device_enrollments_app_current_device") ||
      message.includes("UNIQUE constraint failed: device_enrollments.app_id, device_enrollments.current_device_id")) {
    return { status: 409, error: "device_id is already bound to another active enrollment" };
  }
  if (message.includes("idx_device_enrollments_app_alias") ||
      message.includes("UNIQUE constraint failed: device_enrollments.app_id, device_enrollments.alias")) {
    return { status: 409, error: "enrollment alias already exists" };
  }
  if (message.includes("device_enrollment_operations.app_id, device_enrollment_operations.operation_id")) {
    return { status: 409, error: "operation_id already exists with different input" };
  }
  return { status: 400, error: message };
}

export async function handleListDeviceEnrollments(c: EnrollmentContext) {
  const appId = c.req.param("appId") ?? "";
  const platformError = await requireAndroidApp(c, appId);
  if (platformError) return platformError;
  const { results: enrollments } = await c.env.DB.prepare(
    `${ENROLLMENT_SELECT} WHERE app_id = ?1 ORDER BY lower(alias), id`,
  ).bind(appId).all<DeviceEnrollmentRow>();
  return c.json({ enrollments });
}

export async function handleCreateDeviceEnrollment(c: EnrollmentContext) {
  const appId = c.req.param("appId") ?? "";
  const platformError = await requireAndroidApp(c, appId);
  if (platformError) return platformError;
  const body = await c.req.json().catch(() => ({})) as {
    alias?: unknown;
    label?: unknown;
    device_id?: unknown;
    operation_id?: unknown;
  };
  try {
    const alias = normalizeAlias(body.alias);
    const label = normalizeLabel(body.label);
    const deviceId = normalizeDeviceId(body.device_id);
    const operationId = normalizeOperationId(body.operation_id);
    const replay = await getOperation(c.env.DB, appId, operationId);
    if (replay) {
      if (!await createOperationMatches(c.env.DB, replay, alias, label, deviceId)) {
        return c.json({ error: "operation_id already exists with different input" }, 409);
      }
      return operationResponse(c, replay.enrollment_id, replay, true);
    }
    const enrollmentId = crypto.randomUUID();
    const actor = currentActor(c);
    const now = Date.now();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO device_enrollments
           (id, app_id, alias, label, current_device_id, status, revision,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', 1, ?6, ?6, ?7, ?7)`,
        ).bind(enrollmentId, appId, alias, label, deviceId, actor, now),
        c.env.DB.prepare(
          `INSERT INTO device_enrollment_operations
           (id, app_id, enrollment_id, operation_id, kind, from_device_id,
            to_device_id, expected_revision, resulting_revision,
            migrated_group_memberships, migrated_feature_flags, actor, created_at)
         VALUES (?1, ?2, ?3, ?4, 'create', NULL, ?5, NULL, 1, 0, 0, ?6, ?7)`,
        ).bind(crypto.randomUUID(), appId, enrollmentId, operationId, deviceId, actor, now),
        c.env.DB.prepare(
          `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
         VALUES (?1, ?2, 'device_enrollment.create', ?3, ?4, ?5)`,
        ).bind(
          crypto.randomUUID(),
          appId,
          actor,
          JSON.stringify({ enrollment_id: enrollmentId, alias, label, device_id: deviceId, operation_id: operationId }),
          now,
        ),
      ]);
    } catch (error) {
      const concurrentReplay = await getOperation(c.env.DB, appId, operationId);
      if (concurrentReplay && await createOperationMatches(
        c.env.DB,
        concurrentReplay,
        alias,
        label,
        deviceId,
      )) {
        return operationResponse(c, concurrentReplay.enrollment_id, concurrentReplay, true);
      }
      throw error;
    }
    const enrollment = await getEnrollment(c.env.DB, appId, enrollmentId);
    const operation = await getOperation(c.env.DB, appId, operationId);
    if (!enrollment || !operation) {
      return c.json({ error: "device enrollment create receipt missing" }, 500);
    }
    return c.json({ enrollment, operation, replayed: false }, 201);
  } catch (error) {
    const mapped = mapMutationError(error instanceof Error ? error.message : String(error));
    return c.json({ error: mapped.error }, mapped.status);
  }
}

export async function handleRebindDeviceEnrollment(c: EnrollmentContext) {
  return mutateEnrollment(c, "rebind");
}

export async function handleRevokeDeviceEnrollment(c: EnrollmentContext) {
  return mutateEnrollment(c, "revoke");
}

async function mutateEnrollment(c: EnrollmentContext, kind: "rebind" | "revoke") {
  const appId = c.req.param("appId") ?? "";
  const platformError = await requireAndroidApp(c, appId);
  if (platformError) return platformError;
  const enrollmentId = c.req.param("enrollmentId") ?? "";
  const body = await c.req.json().catch(() => ({})) as {
    device_id?: unknown;
    expected_revision?: unknown;
    operation_id?: unknown;
  };

  let expectedRevision: number;
  let operationId: string;
  let toDeviceId: string | null = null;
  try {
    expectedRevision = normalizeExpectedRevision(body.expected_revision);
    operationId = normalizeOperationId(body.operation_id);
    if (kind === "rebind") toDeviceId = normalizeDeviceId(body.device_id);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  const replay = await getOperation(c.env.DB, appId, operationId);
  if (replay) {
    if (!operationMatches(replay, enrollmentId, kind, expectedRevision, toDeviceId)) {
      return c.json({ error: "operation_id already exists with different input" }, 409);
    }
    return operationResponse(c, enrollmentId, replay, true);
  }

  const enrollment = await getEnrollment(c.env.DB, appId, enrollmentId);
  if (!enrollment) return c.json({ error: "device enrollment not found" }, 404);
  if (enrollment.status !== "active" || !enrollment.current_device_id) {
    return c.json({ error: "device enrollment is revoked" }, 409);
  }
  if (enrollment.revision !== expectedRevision) {
    return c.json({ error: "stale expected_revision", current_revision: enrollment.revision }, 409);
  }
  if (kind === "rebind" && enrollment.current_device_id === toDeviceId) {
    return c.json({ error: "device enrollment is already bound to device_id" }, 409);
  }

  const fromDeviceId = enrollment.current_device_id;
  const resultingRevision = expectedRevision + 1;
  const actor = currentActor(c);
  const now = Date.now();
  const operationDbId = crypto.randomUUID();
  const operationInsert = c.env.DB.prepare(
    `INSERT INTO device_enrollment_operations
       (id, app_id, enrollment_id, operation_id, kind, from_device_id,
        to_device_id, expected_revision, resulting_revision,
        migrated_group_memberships, migrated_feature_flags, actor, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            (SELECT COUNT(*) FROM device_group_members m JOIN device_groups g ON g.id = m.group_id
              WHERE g.app_id = ?2 AND m.device_id = ?6),
            (SELECT COUNT(*) FROM feature_flags f WHERE f.app_id = ?2 AND (${flagReferencesDeviceSql("?6")})),
            ?10, ?11`,
  ).bind(
    operationDbId,
    appId,
    enrollmentId,
    operationId,
    kind,
    fromDeviceId,
    toDeviceId,
    expectedRevision,
    resultingRevision,
    actor,
    now,
  );

  const statements: D1PreparedStatement[] = [operationInsert];
  if (kind === "rebind") {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO device_group_members (group_id, device_id, label, created_at)
         SELECT m.group_id, ?1, m.label, m.created_at
         FROM device_group_members m
         JOIN device_groups g ON g.id = m.group_id
         WHERE g.app_id = ?2 AND m.device_id = ?3
         ON CONFLICT(group_id, device_id) DO UPDATE SET
           label = COALESCE(excluded.label, device_group_members.label)`,
      ).bind(toDeviceId, appId, fromDeviceId),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE device_groups SET updated_at = ?1
       WHERE app_id = ?2 AND id IN (
         SELECT group_id FROM device_group_members WHERE device_id = ?3
       )`,
    ).bind(now, appId, fromDeviceId),
    c.env.DB.prepare(
      `DELETE FROM device_group_members
       WHERE device_id = ?1 AND group_id IN (SELECT id FROM device_groups WHERE app_id = ?2)`,
    ).bind(fromDeviceId, appId),
  );

  if (kind === "rebind") {
    statements.push(
      c.env.DB.prepare(
        `UPDATE feature_flags
         SET allow_device_ids = ${jsonArrayReplaceSql("allow_device_ids")},
             deny_device_ids = ${jsonArrayReplaceSql("deny_device_ids")},
             updated_at = ?3,
             updated_by = ?4
         WHERE app_id = ?5 AND (${flagReferencesDeviceSql()})`,
      ).bind(fromDeviceId, toDeviceId, now, actor, appId),
      c.env.DB.prepare(
        `UPDATE device_enrollments
         SET current_device_id = ?1, revision = ?2, updated_by = ?3,
             updated_at = ?4, last_rebound_at = ?4
         WHERE id = ?5 AND app_id = ?6`,
      ).bind(toDeviceId, resultingRevision, actor, now, enrollmentId, appId),
    );
  } else {
    statements.push(
      c.env.DB.prepare(
        `UPDATE feature_flags
         SET allow_device_ids = ${jsonArrayRemoveSql("allow_device_ids")},
             deny_device_ids = ${jsonArrayRemoveSql("deny_device_ids")},
             updated_at = ?2,
             updated_by = ?3
         WHERE app_id = ?4 AND (${flagReferencesDeviceSql()})`,
      ).bind(fromDeviceId, now, actor, appId),
      c.env.DB.prepare(
        `UPDATE device_enrollments
         SET current_device_id = NULL, status = 'revoked', revision = ?1,
             updated_by = ?2, updated_at = ?3, revoked_at = ?3
         WHERE id = ?4 AND app_id = ?5`,
      ).bind(resultingRevision, actor, now, enrollmentId, appId),
    );
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      `device_enrollment.${kind}`,
      actor,
      JSON.stringify({
        enrollment_id: enrollmentId,
        alias: enrollment.alias,
        operation_id: operationId,
        from_device_id: fromDeviceId,
        to_device_id: toDeviceId,
        expected_revision: expectedRevision,
        resulting_revision: resultingRevision,
      }),
      now,
    ),
  );

  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    const concurrentReplay = await getOperation(c.env.DB, appId, operationId);
    if (concurrentReplay && operationMatches(
      concurrentReplay,
      enrollmentId,
      kind,
      expectedRevision,
      toDeviceId,
    )) {
      return operationResponse(c, enrollmentId, concurrentReplay, true);
    }
    const mapped = mapMutationError(error instanceof Error ? error.message : String(error));
    return c.json({ error: mapped.error }, mapped.status);
  }

  const operation = await getOperation(c.env.DB, appId, operationId);
  if (!operation) return c.json({ error: "device enrollment operation receipt missing" }, 500);
  return operationResponse(c, enrollmentId, operation, false);
}
