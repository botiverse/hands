import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

type AppRow = { id: string; slug: string };
type Webhook = {
  id: string;
  app_id: string | null;
  url: string;
  events_json: string;
  enabled: number | boolean;
  created_at: number;
  updated_at: number;
};
type Delivery = {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_response_status: number | null;
  last_error: string | null;
  created_at: number;
};

/**
 * `hands webhooks` — app-scoped webhooks (app admin). The server pins every
 * webhook created here to the given app; org-wide webhooks stay org-admin-only
 * and are not visible through these commands.
 *
 * Secrets never travel on argv (shell history, `ps`): pass `--secret-stdin`
 * to pipe one in, or omit it on create to have a random secret generated and
 * printed exactly once.
 */
export function registerWebhookCommands(program: Command): void {
  const webhooks = program.command("webhooks").description("Manage webhooks for an app (app admin).");

  webhooks.command("list <appIdOrSlug>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ webhooks: Webhook[] }>(`/api/apps/${appId}/webhooks`);
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      if (result.webhooks.length === 0) return console.log("No webhooks.");
      for (const w of result.webhooks) {
        const events = safeJsonArray(w.events_json);
        console.log(
          `${w.id}  ${w.url}  events=${events.length ? events.join(",") : "*"}  ${w.enabled ? "enabled" : "disabled"}`,
        );
      }
    });

  webhooks.command("create <appIdOrSlug>")
    .requiredOption("--url <url>", "Endpoint that receives signed POSTs (X-Hands-Signature).")
    .option("--events <list>", "Comma-separated events, e.g. release:new,build:failed (default: all).")
    .option("--secret-stdin", "Read the signing secret from stdin instead of generating one.", false)
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      opts: { url: string; events?: string; secretStdin?: boolean; json?: boolean },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const generated = !opts.secretStdin;
      const secret = generated ? randomBytes(32).toString("hex") : await readSecretFromStdin();
      const body: Record<string, unknown> = { url: opts.url, secret };
      if (opts.events !== undefined) body.events = parseList(opts.events);
      const result = await apiRequest<{ id: string; url: string; events: string[] }>(
        `/api/apps/${appId}/webhooks`,
        { method: "POST", body },
      );
      if (opts.json) {
        return console.log(JSON.stringify(generated ? { ...result, secret } : result, null, 2));
      }
      console.log(`Created webhook ${result.id} -> ${result.url} (events: ${result.events.length ? result.events.join(",") : "*"}).`);
      if (generated) {
        console.log(`Signing secret (shown once, store it now): ${secret}`);
      }
    });

  webhooks.command("update <appIdOrSlug> <webhookId>")
    .option("--url <url>", "New endpoint URL.")
    .option("--events <list>", "Replace the subscribed events (comma-separated; empty = all).")
    .option("--enable", "Enable the webhook.")
    .option("--disable", "Disable the webhook.")
    .option("--secret-stdin", "Rotate the signing secret, reading the new one from stdin.", false)
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      webhookId: string,
      opts: { url?: string; events?: string; enable?: boolean; disable?: boolean; secretStdin?: boolean; json?: boolean },
    ) => {
      if (opts.enable && opts.disable) throw new Error("Pass only one of --enable / --disable.");
      const appId = await resolveAppId(appIdOrSlug);
      const body: Record<string, unknown> = {};
      if (opts.url !== undefined) body.url = opts.url;
      if (opts.events !== undefined) body.events = parseList(opts.events);
      if (opts.enable) body.enabled = true;
      if (opts.disable) body.enabled = false;
      if (opts.secretStdin) body.secret = await readSecretFromStdin();
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to update: pass --url, --events, --enable/--disable or --secret-stdin.");
      }
      const result = await apiRequest<{ ok: true }>(`/api/apps/${appId}/webhooks/${encodeURIComponent(webhookId)}`, {
        method: "PATCH",
        body,
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Updated webhook ${webhookId}.`);
    });

  webhooks.command("delete <appIdOrSlug> <webhookId>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, webhookId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ ok: true }>(`/api/apps/${appId}/webhooks/${encodeURIComponent(webhookId)}`, {
        method: "DELETE",
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Deleted webhook ${webhookId}.`);
    });

  webhooks.command("deliveries <appIdOrSlug> <webhookId>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, webhookId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ deliveries: Delivery[] }>(
        `/api/apps/${appId}/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
      );
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      if (result.deliveries.length === 0) return console.log("No deliveries.");
      for (const d of result.deliveries) {
        const outcome = d.last_response_status ?? d.last_error ?? "-";
        console.log(`${new Date(d.created_at).toISOString()}  ${d.event_type}  ${d.status}  attempts=${d.attempts}  ${outcome}`);
      }
    });
}

async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("--secret-stdin expects the secret on stdin, e.g. `printf %s \"$SECRET\" | hands webhooks create ...`.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret) throw new Error("--secret-stdin: stdin was empty.");
  return secret;
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}

function parseList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
