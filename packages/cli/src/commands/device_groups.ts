import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { apiRequest } from "../lib/api.js";

type AppRow = { id: string; slug: string };
type DeviceGroup = {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  members: Array<{ device_id: string; label: string | null }>;
};

type DeviceEnrollment = {
  id: string;
  alias: string;
  label: string | null;
  current_device_id: string | null;
  status: "active" | "revoked";
  revision: number;
};

type DeviceEnrollmentResult = {
  enrollment: DeviceEnrollment;
  operation: Record<string, unknown>;
  replayed: boolean;
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

  const enrollments = program.command("device-enrollments")
    .description("Manage revocable test-device aliases across app reinstall/clear-data.");

  enrollments.command("list <appIdOrSlug>").option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ enrollments: DeviceEnrollment[] }>(
        `/api/apps/${appId}/device-enrollments`,
      );
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      if (result.enrollments.length === 0) return console.log("No device enrollments.");
      for (const enrollment of result.enrollments) {
        console.log(
          `${enrollment.id}  ${enrollment.alias}  status=${enrollment.status} revision=${enrollment.revision}` +
          `${enrollment.current_device_id ? ` device=${enrollment.current_device_id}` : ""}`,
        );
      }
    });

  enrollments.command("create <appIdOrSlug>")
    .requiredOption("--alias <alias>", "Stable app-scoped test-device alias.")
    .requiredOption("--device-id <id>", "Current random Hands per-install id.")
    .option("--label <label>", "Human-readable device label.")
    .option("--operation-id <id>", "Idempotency key; generated when omitted.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      opts: { alias: string; deviceId: string; label?: string; operationId?: string; json?: boolean },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const operationId = opts.operationId ?? randomUUID();
      const result = await apiRequest<DeviceEnrollmentResult>(`/api/apps/${appId}/device-enrollments`, {
        method: "POST",
        body: {
          alias: opts.alias,
          device_id: opts.deviceId,
          label: opts.label,
          operation_id: operationId,
        },
      });
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(
        `Created device enrollment ${result.enrollment.id} (${result.enrollment.alias}) at revision 1` +
        `${result.replayed ? " (idempotent replay)" : ""}; operation=${operationId}.`,
      );
    });

  enrollments.command("rebind <appIdOrSlug> <enrollmentId>")
    .requiredOption("--device-id <id>", "Replacement random Hands per-install id.")
    .requiredOption("--expected-revision <n>", "Current enrollment revision.", parsePositiveInteger)
    .option("--operation-id <id>", "Idempotency key; generated when omitted.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      enrollmentId: string,
      opts: { deviceId: string; expectedRevision: number; operationId?: string; json?: boolean },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const operationId = opts.operationId ?? randomUUID();
      const result = await apiRequest<DeviceEnrollmentResult>(
        `/api/apps/${appId}/device-enrollments/${enrollmentId}/rebind`,
        {
          method: "POST",
          body: {
            device_id: opts.deviceId,
            expected_revision: opts.expectedRevision,
            operation_id: operationId,
          },
        },
      );
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(
        `Rebound ${result.enrollment.alias} to revision ${result.enrollment.revision}` +
        `${result.replayed ? " (idempotent replay)" : ""}; operation=${operationId}.`,
      );
    });

  enrollments.command("revoke <appIdOrSlug> <enrollmentId>")
    .requiredOption("--expected-revision <n>", "Current enrollment revision.", parsePositiveInteger)
    .option("--operation-id <id>", "Idempotency key; generated when omitted.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      enrollmentId: string,
      opts: { expectedRevision: number; operationId?: string; json?: boolean },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const operationId = opts.operationId ?? randomUUID();
      const result = await apiRequest<DeviceEnrollmentResult>(
        `/api/apps/${appId}/device-enrollments/${enrollmentId}/revoke`,
        {
          method: "POST",
          body: { expected_revision: opts.expectedRevision, operation_id: operationId },
        },
      );
      if (opts.json) return console.log(JSON.stringify(result, null, 2));
      console.log(
        `Revoked ${result.enrollment.alias} at revision ${result.enrollment.revision}` +
        `${result.replayed ? " (idempotent replay)" : ""}; operation=${operationId}.`,
      );
    });
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("expected revision must be a positive integer");
  return parsed;
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}
