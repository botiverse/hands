import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

type AppRow = { id: string; slug: string };
export type TestflightCrash = {
  id: string;
  created_at: string | null;
  asc_build_id: string | null;
  build_number: string | null;
  version: string | null;
  device_model: string | null;
  os_version: string | null;
  architecture: string | null;
  locale: string | null;
  connection_type: string | null;
  battery_percentage: number | null;
  app_uptime_ms: number | null;
  comment: string | null;
};
export type TestflightFeedback = TestflightCrash & {
  screenshots: Array<{ url: string; width: number | null; height: number | null; expires_at: string | null }>;
};
type FeedbackList = {
  bundle_id: string;
  asc_app_id: string;
  feedback: TestflightFeedback[];
  note: string;
};
type CrashList = {
  bundle_id: string;
  asc_app_id: string;
  crashes: TestflightCrash[];
  note: string;
};

/**
 * `hands testflight crashes` — tester-submitted TestFlight crashes pulled from
 * App Store Connect with the app's stored ASC key (app viewer). `--download`
 * saves each crash log as <dir>/testflight-crash-<id>.ips.
 */
export function registerTestflightCommands(program: Command): void {
  const testflight = program.command("testflight").description("TestFlight data pulled from App Store Connect.");

  testflight
    .command("crashes <appIdOrSlug>")
    .description("List tester-submitted TestFlight crashes (newest first); --download saves the crash logs.")
    .option("--build <number>", "Build number (CFBundleVersion), e.g. 11200001.")
    .option("--app-version <version>", "Marketing version (e.g. 1.12.0) to pin the build number to (needs --build).")
    .option("--limit <n>", "Max crashes (1-200).", "20")
    .option("--download [dir]", "Save each crash log as <dir>/testflight-crash-<id>.ips (default: cwd).")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: { build?: string; appVersion?: string; limit: string; download?: string | boolean; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const list = await apiRequest<CrashList>(`/api/apps/${appId}/testflight-crashes`, {
          query: { build: opts.build, version: opts.appVersion, limit: opts.limit },
        });
        const saved: Record<string, string> = {};
        if (opts.download !== undefined && opts.download !== false) {
          const dir = typeof opts.download === "string" ? opts.download : ".";
          await mkdir(dir, { recursive: true });
          for (const crash of list.crashes) {
            const res = await apiRequest<Response>(
              `/api/apps/${appId}/testflight-crashes/${encodeURIComponent(crash.id)}/log`,
              { raw: true },
            );
            if (!res.ok) {
              const detail = await res.text().catch(() => "");
              console.error(`  ✘ ${crash.id}: ${res.status} ${detail.slice(0, 200)}`);
              continue;
            }
            const path = join(dir, `testflight-crash-${crash.id}.ips`);
            await writeFile(path, await res.text());
            saved[crash.id] = path;
          }
        }
        if (opts.json || program.opts<{ json?: boolean }>().json) {
          console.log(JSON.stringify({ ...list, saved }, null, 2));
          return;
        }
        console.log(formatCrashTable(list.crashes, saved));
        if (list.crashes.length === 0) console.log(`(${list.note})`);
      },
    );
  testflight
    .command("feedback <appIdOrSlug>")
    .description("List tester-submitted TestFlight screenshot feedback (newest first); --download saves the screenshots.")
    .option("--build <number>", "Build number (CFBundleVersion), e.g. 11200001.")
    .option("--app-version <version>", "Marketing version (e.g. 1.12.0) to pin the build number to (needs --build).")
    .option("--limit <n>", "Max submissions (1-200).", "20")
    .option("--download [dir]", "Save screenshots as <dir>/testflight-feedback-<id>-<n>.<ext> (default: cwd).")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: { build?: string; appVersion?: string; limit: string; download?: string | boolean; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const list = await apiRequest<FeedbackList>(`/api/apps/${appId}/testflight-feedback`, {
          query: { build: opts.build, version: opts.appVersion, limit: opts.limit },
        });
        const saved: Record<string, string> = {};
        if (opts.download !== undefined && opts.download !== false) {
          const dir = typeof opts.download === "string" ? opts.download : ".";
          await mkdir(dir, { recursive: true });
          for (const item of list.feedback) {
            const paths: string[] = [];
            for (const [i, shot] of item.screenshots.entries()) {
              // Apple-signed URL: fetch directly, never with our Hands token.
              const res = await fetch(shot.url);
              if (!res.ok) {
                console.error(`  ✘ ${item.id} screenshot ${i + 1}: ${res.status}`);
                continue;
              }
              const ext = (res.headers.get("content-type") ?? "").includes("jpeg") ? "jpg" : "png";
              const path = join(dir, `testflight-feedback-${item.id}-${i + 1}.${ext}`);
              await writeFile(path, Buffer.from(await res.arrayBuffer()));
              paths.push(path);
            }
            if (paths.length) saved[item.id] = paths.join(", ");
          }
        }
        if (opts.json || program.opts<{ json?: boolean }>().json) {
          console.log(JSON.stringify({ ...list, saved }, null, 2));
          return;
        }
        if (list.feedback.length === 0) {
          console.log("No TestFlight screenshot feedback.");
          return;
        }
        console.log(
          formatCrashTable(
            list.feedback.map((f) => ({ ...f, comment: `${f.comment ?? ""} [${f.screenshots.length} screenshot(s)]`.trim() })),
            saved,
          ),
        );
      },
    );

  testflight
    .command("close <appIdOrSlug> <crash|feedback> <submissionId>")
    .description(
      "Close a TestFlight crash or screenshot feedback after triage. Calls Apple's TestFlight feedback API, " +
        "whose only resolution is delete: the item disappears from App Store Connect.",
    )
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, kind: string, submissionId: string, opts: { json?: boolean }) => {
      if (kind !== "crash" && kind !== "feedback") {
        throw new Error(`kind must be "crash" or "feedback", got "${kind}"`);
      }
      const appId = await resolveAppId(appIdOrSlug);
      const segment = kind === "crash" ? "testflight-crashes" : "testflight-feedback";
      const result = await apiRequest<{ ok: boolean; id: string }>(
        `/api/apps/${appId}/${segment}/${encodeURIComponent(submissionId)}`,
        { method: "DELETE" },
      );
      if (opts.json || program.opts<{ json?: boolean }>().json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`✔ Closed TestFlight ${kind} ${submissionId} (deleted in App Store Connect).`);
    });
}

export function formatCrashTable(crashes: TestflightCrash[], saved: Record<string, string> = {}): string {
  if (crashes.length === 0) return "No TestFlight crash submissions.";
  return crashes
    .map((c) => {
      const build = c.version ? `${c.version} (${c.build_number ?? "?"})` : c.build_number ?? "?";
      const line = [c.created_at ?? "-", build, c.device_model ?? "-", `iOS ${c.os_version ?? "?"}`, c.id].join("\t");
      const extras = [
        c.comment ? `    comment: ${c.comment}` : null,
        saved[c.id] ? `    saved:   ${saved[c.id]}` : null,
      ].filter(Boolean);
      return [line, ...extras].join("\n");
    })
    .join("\n");
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}
