import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

type AppRow = { id: string; slug: string };
type DeviceGroup = {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  members: Array<{ device_id: string; label: string | null }>;
};

export function registerDeviceGroupCommands(program: Command): void {
  const groups = program.command("device-groups").description("Manage exact-rollout installation device groups.");

  groups.command("list <appIdOrSlug>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ groups: DeviceGroup[] }>(`/api/apps/${appId}/device-groups`);
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      if (result.groups.length === 0) return console.log("No device groups.");
      for (const group of result.groups) console.log(`${group.id}  ${group.name}  members=${group.member_count}`);
    });

  groups.command("create <appIdOrSlug>").requiredOption("--name <name>", "Group name.")
    .option("--description <text>", "Operator note.").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { name: string; description?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<DeviceGroup>(`/api/apps/${appId}/device-groups`, {
        method: "POST", body: { name: opts.name, description: opts.description },
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Created device group ${result.id} (${result.name}).`);
    });

  groups.command("update <appIdOrSlug> <groupId>")
    .option("--name <name>", "New group name.")
    .option("--description <text>", "New operator note; pass an empty string to clear it.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      groupId: string,
      opts: { name?: string; description?: string; json?: boolean },
    ) => {
      if (opts.name === undefined && opts.description === undefined) {
        throw new Error("nothing to update: pass --name or --description");
      }
      const appId = await resolveAppId(appIdOrSlug);
      const body: Record<string, unknown> = {};
      if (opts.name !== undefined) body.name = opts.name;
      if (opts.description !== undefined) body.description = opts.description;
      const result = await apiRequest<DeviceGroup>(`/api/apps/${appId}/device-groups/${groupId}`, {
        method: "PATCH", body,
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Updated device group ${result.id} (${result.name}).`);
    });

  groups.command("add-member <appIdOrSlug> <groupId>")
    .requiredOption("--device-id <id>", "Stable Hands installation device id.")
    .option("--label <label>", "Human-readable device label.").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, groupId: string, opts: { deviceId: string; label?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(`/api/apps/${appId}/device-groups/${groupId}/members`, {
        method: "POST", body: { device_id: opts.deviceId, label: opts.label },
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Added device to group ${groupId}.`);
    });

  groups.command("remove-member <appIdOrSlug> <groupId>")
    .requiredOption("--device-id <id>", "Stable Hands installation device id.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, groupId: string, opts: { deviceId: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/device-groups/${groupId}/members/${encodeURIComponent(opts.deviceId)}`,
        { method: "DELETE" },
      );
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Removed device from group ${groupId}.`);
    });

  groups.command("delete <appIdOrSlug> <groupId>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, groupId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(`/api/apps/${appId}/device-groups/${groupId}`, {
        method: "DELETE",
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Deleted device group ${groupId}.`);
    });
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}
