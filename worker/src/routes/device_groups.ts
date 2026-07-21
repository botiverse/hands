import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

type DeviceGroupRow = {
  id: string;
  app_id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  member_count?: number;
};

function normalizeName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("name required");
  if (name.length > 80) throw new Error("name too long (max 80 chars)");
  return name;
}

function normalizeDescription(value: unknown): string | null {
  const description = String(value ?? "").trim();
  if (description.length > 500) throw new Error("description too long (max 500 chars)");
  return description || null;
}

function normalizeDeviceId(value: unknown): string {
  const deviceId = String(value ?? "").trim();
  if (!deviceId) throw new Error("device_id required");
  if (deviceId.length > 256) throw new Error("device_id too long (max 256 chars)");
  return deviceId;
}

function normalizeLabel(value: unknown): string | null {
  const label = String(value ?? "").trim();
  if (label.length > 120) throw new Error("label too long (max 120 chars)");
  return label || null;
}

async function getGroup(db: D1Database, appId: string, groupId: string) {
  return db.prepare(
    `SELECT id, app_id, name, description, created_at, updated_at
     FROM device_groups WHERE id = ?1 AND app_id = ?2`,
  ).bind(groupId, appId).first<DeviceGroupRow>();
}

async function audit(
  db: D1Database,
  appId: string,
  action: string,
  actor: string,
  payload: unknown,
  now = Date.now(),
) {
  await db.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(crypto.randomUUID(), appId, action, actor, JSON.stringify(payload), now).run();
}

export async function handleListDeviceGroups(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const { results: groups } = await c.env.DB.prepare(
    `SELECT g.id, g.app_id, g.name, g.description, g.created_at, g.updated_at,
            COUNT(m.device_id) AS member_count
     FROM device_groups g
     LEFT JOIN device_group_members m ON m.group_id = g.id
     WHERE g.app_id = ?1
     GROUP BY g.id
     ORDER BY lower(g.name), g.id`,
  ).bind(appId).all<DeviceGroupRow>();
  const { results: members } = await c.env.DB.prepare(
    `SELECT m.group_id, m.device_id, m.label, m.created_at
     FROM device_group_members m
     JOIN device_groups g ON g.id = m.group_id
     WHERE g.app_id = ?1
     ORDER BY m.created_at, m.device_id`,
  ).bind(appId).all<{ group_id: string; device_id: string; label: string | null; created_at: number }>();
  return c.json({
    groups: groups.map((group) => ({
      ...group,
      member_count: Number(group.member_count ?? 0),
      members: members.filter((member) => member.group_id === group.id),
    })),
  });
}

export async function handleCreateDeviceGroup(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; description?: unknown };
  try {
    const id = crypto.randomUUID();
    const name = normalizeName(body.name);
    const description = normalizeDescription(body.description);
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(id, appId, name, description, now).run();
    await audit(c.env.DB, appId, "device_group.create", currentActor(c), { group_id: id, name, description }, now);
    return c.json({ id, app_id: appId, name, description, member_count: 0, members: [] }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message.includes("UNIQUE") ? "device group name already exists" : message }, message.includes("UNIQUE") ? 409 : 400);
  }
}

export async function handleUpdateDeviceGroup(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const groupId = c.req.param("groupId") ?? "";
  const group = await getGroup(c.env.DB, appId, groupId);
  if (!group) return c.json({ error: "device group not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; description?: unknown };
  try {
    const name = body.name === undefined ? group.name : normalizeName(body.name);
    const description = body.description === undefined ? group.description : normalizeDescription(body.description);
    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE device_groups SET name = ?1, description = ?2, updated_at = ?3
       WHERE id = ?4 AND app_id = ?5`,
    ).bind(name, description, now, groupId, appId).run();
    await audit(c.env.DB, appId, "device_group.update", currentActor(c), { group_id: groupId, name, description }, now);
    return c.json({ id: groupId, app_id: appId, name, description });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message.includes("UNIQUE") ? "device group name already exists" : message }, message.includes("UNIQUE") ? 409 : 400);
  }
}

export async function handleDeleteDeviceGroup(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const groupId = c.req.param("groupId") ?? "";
  const group = await getGroup(c.env.DB, appId, groupId);
  if (!group) return c.json({ error: "device group not found" }, 404);
  const usage = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM release_scopes s
     JOIN releases r ON r.id = s.release_id
     WHERE r.app_id = ?1 AND s.scope_type = 'device_group' AND s.scope_value = ?2
       AND r.status IN ('draft', 'active')`,
  ).bind(appId, groupId).first<{ count: number }>();
  if (Number(usage?.count ?? 0) > 0) {
    return c.json({ error: "device group is used by a draft or active release" }, 409);
  }
  const now = Date.now();
  try {
    await c.env.DB.prepare("DELETE FROM device_groups WHERE id = ?1 AND app_id = ?2").bind(groupId, appId).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("device group is used by a draft or active release")) {
      return c.json({ error: "device group is used by a draft or active release" }, 409);
    }
    throw error;
  }
  await audit(c.env.DB, appId, "device_group.delete", currentActor(c), { group_id: groupId, name: group.name }, now);
  return c.json({ ok: true, id: groupId });
}

export async function handleAddDeviceGroupMember(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const groupId = c.req.param("groupId") ?? "";
  const group = await getGroup(c.env.DB, appId, groupId);
  if (!group) return c.json({ error: "device group not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { device_id?: unknown; label?: unknown };
  try {
    const deviceId = normalizeDeviceId(body.device_id);
    const label = normalizeLabel(body.label);
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO device_group_members (group_id, device_id, label, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(group_id, device_id) DO UPDATE SET label = excluded.label`,
    ).bind(groupId, deviceId, label, now).run();
    await c.env.DB.prepare("UPDATE device_groups SET updated_at = ?1 WHERE id = ?2 AND app_id = ?3").bind(now, groupId, appId).run();
    await audit(c.env.DB, appId, "device_group.member_upsert", currentActor(c), {
      group_id: groupId,
      device_id: deviceId,
      label,
    }, now);
    return c.json({ group_id: groupId, device_id: deviceId, label }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export async function handleRemoveDeviceGroupMember(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const groupId = c.req.param("groupId") ?? "";
  const group = await getGroup(c.env.DB, appId, groupId);
  if (!group) return c.json({ error: "device group not found" }, 404);
  let deviceId: string;
  try {
    deviceId = normalizeDeviceId(decodeURIComponent(c.req.param("deviceId") ?? ""));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    "DELETE FROM device_group_members WHERE group_id = ?1 AND device_id = ?2",
  ).bind(groupId, deviceId).run();
  await c.env.DB.prepare("UPDATE device_groups SET updated_at = ?1 WHERE id = ?2 AND app_id = ?3").bind(now, groupId, appId).run();
  await audit(c.env.DB, appId, "device_group.member_remove", currentActor(c), { group_id: groupId, device_id: deviceId }, now);
  return c.json({ ok: true, group_id: groupId, device_id: deviceId });
}
