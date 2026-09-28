import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

type AppRow = { id: string; slug: string };
export type AgcSubmission = {
  id: string;
  build_id: string;
  state: string;
  external_app_id: string | null;
  external_version_id: string | null;
  external_package_id: string | null;
  error_message: string | null;
  provider_state: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};
type AgcGroup = { groupId: string; groupName?: string | null; addedTestersNum?: number | null };

/**
 * `hands agc …` — AppGallery Connect invitation testing for OHOS builds
 * (Huawei App Testing, releaseType 6). Store listing / phased release is not
 * automated. Every `status` read makes the server re-read Huawei while the
 * review outcome is open.
 */
export function registerAgcCommands(program: Command): void {
  const agc = program.command("agc").description("AppGallery Connect invitation testing for HarmonyOS builds.");
  const wantsJson = (opts: { json?: boolean }) => Boolean(opts.json || program.opts<{ json?: boolean }>().json);

  agc
    .command("groups <appIdOrSlug>")
    .description("List AGC test user groups (group id, name, tester count).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ groups: AgcGroup[] }>(`/api/apps/${appId}/agc-test-groups`);
      if (wantsJson(opts)) return void console.log(JSON.stringify(res, null, 2));
      if (res.groups.length === 0) return void console.log("No AGC test groups. Create one in AppGallery Connect → App Testing.");
      for (const g of res.groups) console.log([g.groupId, g.groupName ?? "-", `${g.addedTestersNum ?? "?"} testers`].join("\t"));
    });

  agc
    .command("upload <appIdOrSlug> <buildId>")
    .description("Upload the build's signed .app to AGC and create an invitation-test version (idempotent per build; repeats after failed/rejected/stopped start a new attempt).")
    .requiredOption("--package-name <name>", "HarmonyOS bundle name, e.g. build.raft.mobile.")
    .option("--test-desc <text>", "Test description shown to testers.")
    .option("--wait", "Poll until Huawei finishes compiling (ready or failed).", false)
    .option("--timeout <seconds>", "Max seconds for --wait.", "600")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, buildId: string, opts: { packageName: string; testDesc?: string; wait?: boolean; timeout: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const started = await apiRequest<{ submission_id?: string; submission?: AgcSubmission; state?: string }>(
        `/api/apps/${appId}/builds/${encodeURIComponent(buildId)}/agc-invitation-test`,
        { method: "POST", body: { package_name: opts.packageName, ...(opts.testDesc ? { test_desc: opts.testDesc } : {}) } },
      );
      const submissionId = started.submission_id ?? started.submission?.id;
      if (!submissionId) throw new Error("server did not return a submission id");
      let result = await getStatus(appId, submissionId);
      if (opts.wait) result = await waitFor(appId, submissionId, (s) => s !== "uploading" && s !== "processing", Number(opts.timeout));
      if (wantsJson(opts)) return void console.log(JSON.stringify(result, null, 2));
      console.log(formatSubmission(result.submission, result.sync_error));
      if (result.submission.state === "ready") console.log(`Next: hands agc submit ${appIdOrSlug} ${submissionId} --group <groupId>`);
    });

  agc
    .command("submit <appIdOrSlug> <submissionId>")
    .description("Submit a ready test version to Huawei review for the given test group(s). Required when the app has more than one group.")
    .option("--group <groupId...>", "AGC test group id(s); see `hands agc groups`.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, submissionId: string, opts: { group?: string[]; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ submission?: AgcSubmission; group_ids?: string[] }>(
        `/api/apps/${appId}/agc-submissions/${encodeURIComponent(submissionId)}/submit`,
        { method: "POST", body: opts.group?.length ? { group_ids: opts.group } : {} },
      );
      if (wantsJson(opts)) return void console.log(JSON.stringify(res, null, 2));
      console.log(`✔ Submitted ${submissionId} to AppGallery invitation-test review (groups: ${(res.group_ids ?? []).join(", ") || "-"}).`);
      console.log(`Check the outcome: hands agc status ${appIdOrSlug} ${submissionId}`);
    });

  agc
    .command("status <appIdOrSlug> <submissionIdOrBuildId>")
    .description("Show a submission (refreshed from Huawei). Accepts a submission id, or a full build id with --build.")
    .option("--build", "Treat the id as a build id and show its latest submission.", false)
    .option("--events", "Include the state history.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, id: string, opts: { build?: boolean; events?: boolean; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      let submissionId = id;
      if (opts.build) {
        const latest = await apiRequest<{ submission: AgcSubmission | null }>(`/api/apps/${appId}/builds/${encodeURIComponent(id)}/agc-invitation-test`);
        if (!latest.submission) throw new Error(`No AppGallery submission for build ${id}`);
        submissionId = latest.submission.id;
      }
      const res = await getStatus(appId, submissionId);
      if (wantsJson(opts)) return void console.log(JSON.stringify(res, null, 2));
      console.log(formatSubmission(res.submission, res.sync_error));
      if (opts.events) for (const e of res.events) console.log(`  ${new Date(e.created_at).toISOString()}\t${e.state}`);
    });
}

type StatusResponse = { submission: AgcSubmission; events: Array<{ state: string; detail_json: string; created_at: number }>; sync_error?: string };

async function getStatus(appId: string, submissionId: string): Promise<StatusResponse> {
  return apiRequest<StatusResponse>(`/api/apps/${appId}/agc-submissions/${encodeURIComponent(submissionId)}`);
}

async function waitFor(appId: string, submissionId: string, done: (state: string) => boolean, timeoutSeconds: number, intervalMs = 5000): Promise<StatusResponse> {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  for (;;) {
    const res = await getStatus(appId, submissionId);
    if (done(res.submission.state) || Date.now() >= deadline) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function formatSubmission(sub: AgcSubmission, syncError?: string): string {
  const ps = sub.provider_state ?? {};
  const lines = [`${sub.id}\t${sub.state}\tbuild ${sub.build_id}`];
  if (typeof ps.release_state === "number") lines.push(`  huawei releaseState: ${ps.release_state}`);
  if (typeof ps.audit_opinion === "string" && ps.audit_opinion) lines.push(`  huawei opinion:     ${ps.audit_opinion}`);
  if (Array.isArray(ps.group_ids) && ps.group_ids.length) lines.push(`  groups:             ${ps.group_ids.join(", ")}`);
  if (sub.error_message) lines.push(`  error:              ${sub.error_message}`);
  if (syncError) lines.push(`  (could not refresh from Huawei: ${syncError})`);
  return lines.join("\n");
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}
