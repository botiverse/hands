/**
 * /api/apps/:appId/operations — operation log CRUD + SSE stream.
 *
 * Every async task the admin initiates (parse / upload / publish) records an
 * entry in the `operation_logs` D1 table. Clients subscribe to the SSE
 * stream to receive real-time updates; on disconnect they can fetch the
 * recent list via the list endpoint.
 *
 * SSE protocol:
 *   - response Content-Type: text/event-stream
 *   - heartbeat comments every 15s to keep connection alive through proxies
 *   - on each op state change: `data: {<op JSON>}\n\n`
 *   - on connect: replay all in-flight ops (so the UI catches up)
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

export interface OperationLog {
  id: string;
  /** Nullable — parse operations are app-less (run before the user picks an app). */
  app_id: string | null;
  kind: "parse" | "upload" | "publish" | "signed_url";
  status: "pending" | "in_progress" | "success" | "failed" | "cancelled";
  parent_op_id: string | null;
  step_number: number | null;
  actor: string;
  input: string; // JSON
  output: string; // JSON
  error: string | null;
  progress: number;
  retry_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// Helper: insert + return the created row.
export async function createOperation(
  db: D1Database,
  partial: Pick<OperationLog, "app_id" | "kind"> &
    Partial<
      Pick<OperationLog, "parent_op_id" | "step_number" | "input" | "actor">
    >,
): Promise<OperationLog> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const row: OperationLog = {
    id,
    app_id: partial.app_id,
    kind: partial.kind,
    status: "pending",
    parent_op_id: partial.parent_op_id ?? null,
    step_number: partial.step_number ?? null,
    actor: partial.actor ?? "admin",
    input: partial.input ?? "{}",
    output: "{}",
    error: null,
    progress: 0,
    retry_count: 0,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  await db
    .prepare(
      `INSERT INTO operation_logs
       (id, app_id, kind, status, parent_op_id, step_number, actor,
        input, output, error, progress, retry_count, created_at, updated_at, completed_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
    )
    .bind(
      row.id,
      row.app_id,
      row.kind,
      row.status,
      row.parent_op_id,
      row.step_number,
      row.actor,
      row.input,
      row.output,
      row.error,
      row.progress,
      row.retry_count,
      row.created_at,
      row.updated_at,
      row.completed_at,
    )
    .run();
  return row;
}

export async function updateOperation(
  db: D1Database,
  id: string,
  patch: Partial<
    Pick<
      OperationLog,
      "status" | "output" | "error" | "progress" | "completed_at" | "retry_count"
    >
  >,
): Promise<OperationLog | null> {
  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const binds: any[] = [now];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (patch.output !== undefined) {
    sets.push("output = ?");
    binds.push(patch.output);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    binds.push(patch.error);
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    binds.push(patch.progress);
  }
  if (patch.completed_at !== undefined) {
    sets.push("completed_at = ?");
    binds.push(patch.completed_at);
  }
  if (patch.retry_count !== undefined) {
    sets.push("retry_count = ?");
    binds.push(patch.retry_count);
  }
  binds.push(id);
  await db
    .prepare(`UPDATE operation_logs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  const after = await db
    .prepare("SELECT * FROM operation_logs WHERE id = ?")
    .bind(id)
    .first<OperationLog>();
  return after ?? null;
}

export async function getOperation(
  db: D1Database,
  id: string,
): Promise<OperationLog | null> {
  return await db
    .prepare("SELECT * FROM operation_logs WHERE id = ?")
    .bind(id)
    .first<OperationLog>();
}

// ---------- HTTP handlers ----------

export async function handleListOperations(
  c: Context<{ Bindings: Env }>,
) {
  const appId = c.req.param("appId");
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM operation_logs
     WHERE app_id = ?1
     ORDER BY created_at DESC
     LIMIT ?2`,
  )
    .bind(appId, limit)
    .all<OperationLog>();
  return c.json({ operations: results });
}

export async function handleGetOperation(c: Context<{ Bindings: Env }>) {
  const id = c.req.param("opId") ?? "";
  const row = await getOperation(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}

export async function handleRetryOperation(c: Context<{ Bindings: Env }>) {
  const id = c.req.param("opId") ?? "";
  const existing = await getOperation(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status === "in_progress") {
    return c.json(
      { error: "operation already in_progress; wait or cancel first" },
      409,
    );
  }

  // Mark as in_progress + bump retry_count while we actually re-run the op.
  await updateOperation(c.env.DB, id, {
    status: "in_progress",
    error: null,
    progress: 0.1,
    retry_count: existing.retry_count + 1,
    completed_at: null,
  });

  // parse + upload ops don't store the original bytes (only metadata),
  // so they can't be retried server-side — the user must re-trigger from
  // the UI (Upload dialog). We mark them back to failed with a clear hint.
  if (existing.kind === "parse" || existing.kind === "upload") {
    const retried = await updateOperation(c.env.DB, id, {
      status: "failed",
      error: `retry not supported for kind='${existing.kind}'; re-trigger from admin UI`,
      completed_at: Date.now(),
    });
    return c.json(retried, 400);
  }

  // publish ops store the full metadata JSON in `input` — re-run insertVersion.
  if (existing.kind === "publish") {
    if (!existing.app_id) {
      const failed = await updateOperation(c.env.DB, id, {
        status: "failed",
        error: "publish op has no app_id; cannot retry",
        completed_at: Date.now(),
      });
      return c.json(failed, 400);
    }
    try {
      const input = JSON.parse(existing.input) as {
        channel: string;
        version_name: string;
        version_code: number;
        package_name: string;
        signature_sha256: string;
        min_sdk?: number;
        target_sdk?: number;
        size_bytes: number;
        file_hash: string;
        r2_key: string;
      };
      const { insertVersion } = await import("./versions");
      const newVersionId = await insertVersion(
        c.env.DB,
        existing.app_id,
        input,
      );
      await c.env.DB
        .prepare(
          "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(
          crypto.randomUUID(),
          existing.app_id,
          "version.create",
          currentActor(c),
          JSON.stringify({ ...input, retried_from: existing.id }),
          Date.now(),
        )
        .run();
      const success = await updateOperation(c.env.DB, id, {
        status: "success",
        progress: 1,
        output: JSON.stringify({ version_id: newVersionId }),
        completed_at: Date.now(),
      });
      return c.json(success);
    } catch (e) {
      const failed = await updateOperation(c.env.DB, id, {
        status: "failed",
        error: (e as Error).message,
        progress: 1,
        completed_at: Date.now(),
      });
      return c.json(failed, 500);
    }
  }

  // Unknown kind — fall back to state reset.
  const retried = await updateOperation(c.env.DB, id, {
    status: "pending",
    error: null,
    progress: 0,
    retry_count: existing.retry_count + 1,
    completed_at: null,
  });
  return c.json(retried);
}

export async function handleDeleteOperation(c: Context<{ Bindings: Env }>) {
  const id = c.req.param("opId") ?? "";
  const existing = await getOperation(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM operation_logs WHERE id = ?").bind(id).run();
  return c.json({ ok: true, id });
}

/**
 * SSE stream of operation updates for an app.
 *
 * Sends a heartbeat comment every 15s. On each op state change, emits
 * `data: {<op JSON>}\n\n`. Replays in-flight ops on connect so a freshly
 * loaded page catches up.
 */
export async function handleStreamOperations(
  c: Context<{ Bindings: Env }>,
) {
  const appId = c.req.param("appId");
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const heartbeat = () =>
        controller.enqueue(enc.encode(`: heartbeat\n\n`));

      // 1. Replay in-flight ops (status = pending | in_progress)
      const { results: inFlight } = await c.env.DB.prepare(
        `SELECT * FROM operation_logs
         WHERE app_id = ?1 AND status IN ('pending','in_progress')
         ORDER BY created_at ASC`,
      )
        .bind(appId)
        .all<OperationLog>();
      for (const op of inFlight) send("op", op);

      // 2. Send an initial "ready" event so the client knows the stream is live
      send("ready", { app_id: appId, at: Date.now() });

      // 3. Poll D1 every 1s for changes; emit any updated ops.
      //    A real prod system would use Durable Object pub/sub or a
      //    dedicated event bus — but D1 polling is fine for an admin tool
      //    with sub-100 concurrent admins.
      let lastCheck = Date.now();
      const poll = setInterval(async () => {
        try {
          heartbeat();
          const since = lastCheck - 1000; // overlap 1s to catch near-simultaneous writes
          const { results: updated } = await c.env.DB.prepare(
            `SELECT * FROM operation_logs
             WHERE app_id = ?1 AND updated_at > ?2
             ORDER BY updated_at ASC`,
          )
            .bind(appId, since)
            .all<OperationLog>();
          for (const op of updated) send("op", op);
          lastCheck = Date.now();
        } catch (e) {
          send("error", { message: (e as Error).message });
        }
      }, 1000);

      // 4. Also send a heartbeat every 15s so intermediate proxies don't
      //    close the connection.
      const hb = setInterval(heartbeat, 15_000);

      // 5. Cleanup when the client disconnects.
      const onClose = () => {
        clearInterval(poll);
        clearInterval(hb);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      c.req.raw.signal.addEventListener("abort", onClose);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      // Disable buffering on Cloudflare-specific header
    },
  });
}
