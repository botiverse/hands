import { Hono } from "hono";
import type { Context } from "hono";
import { callback, login, logout, requireAdmin, type AdminSession } from "./auth";
import type { AdminWorkerEnv } from "./env";

export const app = new Hono<{ Bindings: AdminWorkerEnv; Variables: { session: AdminSession } }>();
type AdminContext = Context<{ Bindings: AdminWorkerEnv; Variables: { session: AdminSession } }>;
app.get("/health", (c) => c.json({ ok: true }));
app.get("/login", login);
app.get("/auth/callback", callback);
app.post("/logout", logout);
app.use("/", requireAdmin);
app.use("/api/*", requireAdmin);

async function overview(c: AdminContext) {
  const session = c.get("session");
  const data = await c.env.HANDS_OBSERVABILITY.getOverview();
  await c.env.AUDIT_DB.prepare(
    "INSERT INTO access_audit (id, actor_subject, server_id, action, created_at) VALUES (?1, ?2, ?3, 'overview.view', ?4)",
  ).bind(crypto.randomUUID(), session.sub, session.server_id, Date.now()).run();
  return data;
}

app.get("/api/overview", async (c) => c.json(await overview(c)));

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const bytes = (value: number) => { const units = ["B", "KB", "MB", "GB", "TB"]; let n = value, i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; };

app.get("/", async (c) => {
  const data = await overview(c);
  const session = c.get("session");
  const cards = [["Users", data.summary.users], ["Organizations", data.summary.organizations], ["Projects", data.summary.apps], ["Active projects", data.summary.active_apps], ["Builds", data.summary.builds], ["Releases", data.summary.releases], ["R2 storage", bytes(data.storage.r2.size_bytes)], ["R2 objects", data.storage.r2.object_count]];
  const rows = (items: Array<{ type?: string; status?: string; count: number }>) => items.map((item) => `<tr><td>${esc(item.type ?? item.status)}</td><td>${item.count}</td></tr>`).join("");
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hands Admin</title><style>:root{font-family:Inter,system-ui;color:#0f172a;background:#f8fafc}body{margin:0}.shell{max-width:1180px;margin:auto;padding:40px 24px}header{display:flex;justify-content:space-between;align-items:end;gap:24px}h1{font-size:34px;margin:5px 0}.eyebrow{color:#0284c7;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}.muted{color:#64748b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:28px 0}.card,.panel{background:white;border:1px solid #e2e8f0;border-radius:14px;padding:20px}.value{font-size:30px;font-weight:650;margin-top:8px}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}h2{font-size:15px}table{border-collapse:collapse;width:100%;font-size:14px}td{padding:9px 0;border-top:1px solid #f1f5f9}td:last-child{text-align:right;font-weight:600}button{border:1px solid #cbd5e1;border-radius:8px;background:white;padding:8px 12px}</style></head><body><div class="shell"><header><div><div class="eyebrow">Hands admin</div><h1>Observability</h1><div class="muted">Global, read-only product and storage inventory.</div></div><form method="post" action="/logout"><button>Sign out ${esc(session.name)}</button></form></header><div class="grid">${cards.map(([label,value]) => `<div class="card"><div class="muted">${label}</div><div class="value">${value}</div></div>`).join("")}</div><p class="muted">${esc(data.storage.note)} Measured ${new Date(data.measured_at).toISOString()}.</p><div class="panels"><section class="panel"><h2>Users by type</h2><table>${rows(data.users_by_type)}</table></section><section class="panel"><h2>Projects by platform</h2><table>${rows(data.apps_by_platform)}</table></section><section class="panel"><h2>Builds by product type</h2><table>${rows(data.builds_by_product_type)}</table></section><section class="panel"><h2>Releases by status</h2><table>${rows(data.releases_by_status)}</table></section></div></div></body></html>`);
});

export default app;
