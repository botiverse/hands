import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

type AppRow = { id: string; slug: string };
type Channel = {
  id: string;
  app_id: string;
  slug: string;
  name: string;
  bundle_id: string | null;
  password: string | null;
  git_url: string | null;
  enabled_product_types_json: string;
  metadata_json: string;
  created_at: number;
};

export function registerChannelCommands(program: Command): void {
  const channels = program.command("channels").description("Manage release channels on an app.");

  channels.command("list <appIdOrSlug>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ channels: Channel[] }>(`/api/apps/${appId}/channels`);
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      if (result.channels.length === 0) return console.log("No channels.");
      for (const ch of result.channels) {
        const types = safeJsonArray(ch.enabled_product_types_json);
        const extras = [
          ch.bundle_id ? `bundle=${ch.bundle_id}` : null,
          ch.git_url ? `git=${ch.git_url}` : null,
          types.length ? `types=${types.join(",")}` : null,
        ].filter(Boolean).join("  ");
        console.log(`${ch.slug}  ${ch.name}  id=${ch.id}${extras ? "  " + extras : ""}`);
      }
    });

  channels.command("create <appIdOrSlug>")
    .requiredOption("--slug <slug>", "Channel slug (immutable).")
    .requiredOption("--name <name>", "Display name.")
    .option("--bundle-id <id>", "Bundle id for parallel-install override.")
    .option("--password <pw>", "Shared password for gated downloads.")
    .option("--git-url <url>", "Source URL this channel tracks.")
    .option("--product-types <list>", "Comma-separated enabled product types.")
    .option("--metadata <json>", "Opaque metadata JSON object.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      opts: {
        slug: string; name: string; bundleId?: string; password?: string; gitUrl?: string;
        productTypes?: string; metadata?: string; json?: boolean;
      },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const body: Record<string, unknown> = { slug: opts.slug, name: opts.name };
      if (opts.bundleId !== undefined) body.bundle_id = opts.bundleId;
      if (opts.password !== undefined) body.password = opts.password;
      if (opts.gitUrl !== undefined) body.git_url = opts.gitUrl;
      if (opts.productTypes !== undefined) body.enabled_product_types = parseList(opts.productTypes);
      if (opts.metadata !== undefined) body.metadata = parseJsonObject(opts.metadata, "--metadata");
      const result = await apiRequest<Channel>(`/api/apps/${appId}/channels`, { method: "POST", body });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Created channel ${result.slug} (${result.name}) id=${result.id}.`);
    });

  channels.command("update <appIdOrSlug> <channelIdOrSlug>")
    .option("--name <name>", "New display name.")
    .option("--bundle-id <id>", "New bundle id; pass an empty string to clear it.")
    .option("--password <pw>", "New shared password; pass an empty string to clear it.")
    .option("--git-url <url>", "New git url; pass an empty string to clear it.")
    .option("--product-types <list>", "Comma-separated replacement enabled product types.")
    .option("--metadata <json>", "Replacement metadata JSON object.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      channelIdOrSlug: string,
      opts: {
        name?: string; bundleId?: string; password?: string; gitUrl?: string;
        productTypes?: string; metadata?: string; json?: boolean;
      },
    ) => {
      const body: Record<string, unknown> = {};
      if (opts.name !== undefined) body.name = opts.name;
      if (opts.bundleId !== undefined) body.bundle_id = opts.bundleId;
      if (opts.password !== undefined) body.password = opts.password;
      if (opts.gitUrl !== undefined) body.git_url = opts.gitUrl;
      if (opts.productTypes !== undefined) body.enabled_product_types = parseList(opts.productTypes);
      if (opts.metadata !== undefined) body.metadata = parseJsonObject(opts.metadata, "--metadata");
      if (Object.keys(body).length === 0) {
        throw new Error("nothing to update: pass --name, --bundle-id, --password, --git-url, --product-types or --metadata");
      }
      const appId = await resolveAppId(appIdOrSlug);
      const channelId = await resolveChannelId(appId, channelIdOrSlug);
      const result = await apiRequest<{ ok: boolean }>(`/api/apps/${appId}/channels/${channelId}`, {
        method: "PATCH", body,
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Updated channel ${channelIdOrSlug}.`);
    });

  channels.command("delete <appIdOrSlug> <channelIdOrSlug>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, channelIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const channelId = await resolveChannelId(appId, channelIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(`/api/apps/${appId}/channels/${channelId}`, {
        method: "DELETE",
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Deleted channel ${channelIdOrSlug}.`);
    });
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}

// Channels are addressed by slug in this system (release publish, channels list);
// accept either a slug or a raw UUID and resolve to the channel id.
async function resolveChannelId(appId: string, channelIdOrSlug: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(channelIdOrSlug)) return channelIdOrSlug;
  const { channels } = await apiRequest<{ channels: Channel[] }>(`/api/apps/${appId}/channels`);
  const ch = channels.find((item) => item.slug === channelIdOrSlug || item.id === channelIdOrSlug);
  if (!ch) throw new Error(`Channel not found: ${channelIdOrSlug}`);
  return ch.id;
}

function parseList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseJsonObject(value: string, flag: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${flag} must be a JSON object, e.g. --metadata '{"key":"value"}'`);
  }
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
