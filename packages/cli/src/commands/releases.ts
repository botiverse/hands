/**
 * `quiver releases` — release operations that are not part of build publish.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { readEnv } from "../lib/env.js";

interface AppRow {
  id: string;
  slug: string;
}

interface ReleaseShare {
  id: string;
  release_id: string;
  share_url?: string;
  created_at?: number;
  expires_at: number;
  revoked_at: number | null;
}

const DEFAULT_SHARE_TTL_SECONDS = "604800";

export function registerReleaseCommands(program: Command): void {
  const releases = program
    .command("releases")
    .description("Manage release shares.");

  releases
    .command("show <appIdOrSlug> <releaseId>")
    .description("Show a release (status, changelog, rollout) for review.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, releaseId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const detail = await apiRequest<{ release: Record<string, unknown> }>(
        `/api/apps/${appId}/releases/${releaseId}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      const r = detail.release as {
        id: string;
        status: string;
        changelog: string | null;
        rollout_cohort_count: number | null;
      };
      console.log(`Release ${r.id}`);
      console.log(`  status:  ${r.status}`);
      console.log(`  rollout: ${r.rollout_cohort_count ?? 100}%`);
      console.log(`  changelog:`);
      console.log((r.changelog ?? "(none)").split("\n").map((l) => "    " + l).join("\n"));
    });

  releases
    .command("update <appIdOrSlug> <releaseId>")
    .description("Update a draft/active release; use to write the reviewed changelog before publish.")
    .option(
      "--changelog <text>",
      "Changelog text. Repeatable with lang=text for multiple languages.",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option(
      "--changelog-file <path>",
      "Changelog file. Repeatable with lang=path, e.g. --changelog-file zh=zh.md --changelog-file en=en.md.",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option("--device-group <groupId>", "Replace release scope with one exact-rollout device group UUID.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        opts: {
          changelog?: string[];
          changelogFile?: string[];
          deviceGroup?: string;
          json?: boolean;
        },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        // Each entry is either "text/path" (single-language plain changelog)
        // or "lang=text/path". Language keys are normalized: zh -> zh-CN.
        const langAliases: Record<string, string> = { zh: "zh-CN", cn: "zh-CN" };
        const byLang: Record<string, string> = {};
        let plain: string | undefined;
        const consume = (entry: string, fromFile: boolean) => {
          const eq = entry.indexOf("=");
          if (eq > 0 && eq <= 10) {
            const langRaw = entry.slice(0, eq).trim().toLowerCase();
            const lang = langAliases[langRaw] ?? langRaw;
            const value = entry.slice(eq + 1);
            byLang[lang] = (fromFile ? readFileSync(value, "utf8") : value).trim();
          } else {
            plain = (fromFile ? readFileSync(entry, "utf8") : entry).trim();
          }
        };
        for (const entry of opts.changelog ?? []) consume(entry, false);
        for (const entry of opts.changelogFile ?? []) consume(entry, true);

        let changelog: string | undefined;
        const langs = Object.keys(byLang);
        if (langs.length > 0) {
          if (plain !== undefined) {
            throw new Error("mix of plain and lang= changelog entries; pick one style");
          }
          changelog = JSON.stringify(byLang);
        } else if (plain !== undefined) {
          changelog = plain;
        }
        if (changelog === undefined && !opts.deviceGroup) {
          throw new Error(
            "nothing to update: pass --changelog(-file) or --device-group",
          );
        }
        const body: Record<string, unknown> = {};
        if (changelog !== undefined) body.changelog = changelog;
        if (opts.deviceGroup) {
          body.scopes = [{ scope_type: "device_group", scope_value: opts.deviceGroup }];
        }
        const updated = await apiRequest<Record<string, unknown>>(
          `/api/apps/${appId}/releases/${releaseId}`,
          { method: "PATCH", body },
        );
        if (opts.json) {
          console.log(JSON.stringify(updated, null, 2));
          return;
        }
        console.log(
          `Updated release ${releaseId}${changelog !== undefined ? ` changelog${langs.length ? ` (${langs.join(", ")})` : ""}` : ""}${opts.deviceGroup ? ` scope=device_group:${opts.deviceGroup}` : ""}.`,
        );
      },
    );

  releases
    .command("publish <appIdOrSlug> <releaseId>")
    .description("Publish a draft release (the explicit human/agent step after changelog review).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, releaseId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/releases/${releaseId}/publish`,
        { method: "POST", body: {} },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Published release ${releaseId}.`);
    });

  releases
    .command("share <appIdOrSlug> <releaseId>")
    .description("Create a revocable public share page for a release.")
    .option("--ttl-seconds <seconds>", "Share lifetime in seconds.", DEFAULT_SHARE_TTL_SECONDS)
    .option("--expires-at <millis>", "Absolute expiration as Unix milliseconds.")
    .option(
      "--password <password>",
      "Password-protect the share page (or set QUIVER_SHARE_PASSWORD to keep it out of shell history).",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        opts: { ttlSeconds?: string; expiresAt?: string; password?: string; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const body: { ttl_seconds?: number; expires_at?: number; password?: string } = {};
        if (opts.expiresAt) {
          body.expires_at = parsePositiveNumber(opts.expiresAt, "--expires-at");
        } else {
          body.ttl_seconds = parsePositiveNumber(opts.ttlSeconds ?? DEFAULT_SHARE_TTL_SECONDS, "--ttl-seconds");
        }
        const password = opts.password ?? readEnv("SHARE_PASSWORD");
        if (password) body.password = password;
        const share = await apiRequest<ReleaseShare>(
          `/api/apps/${appId}/releases/${releaseId}/shares`,
          { method: "POST", body },
        );
        if (opts.json) {
          console.log(JSON.stringify(share, null, 2));
          return;
        }
        console.log(`Created release share ${share.id}`);
        console.log(`  url:        ${share.share_url ?? ""}`);
        console.log(`  expires_at: ${new Date(share.expires_at).toISOString()}`);
        if (body.password) console.log("  password:   protected");
      },
    );

  releases
    .command("shares <appIdOrSlug> <releaseId>")
    .description("List public shares for a release.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        opts: { json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const res = await apiRequest<{ shares: ReleaseShare[] }>(
          `/api/apps/${appId}/releases/${releaseId}/shares`,
        );
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.shares.length === 0) {
          console.log("No release shares.");
          return;
        }
        for (const share of res.shares) {
          const state = share.revoked_at ? "revoked" : Date.now() >= share.expires_at ? "expired" : "active";
          console.log(`${share.id}  ${state}  expires=${new Date(share.expires_at).toISOString()}`);
        }
      },
    );

  releases
    .command("update-share <appIdOrSlug> <releaseId> <shareId>")
    .description("Renew or change a public release share expiration.")
    .option("--ttl-seconds <seconds>", "New lifetime in seconds from now.", DEFAULT_SHARE_TTL_SECONDS)
    .option("--expires-at <millis>", "Absolute expiration as Unix milliseconds.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        shareId: string,
        opts: { ttlSeconds?: string; expiresAt?: string; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const body: { ttl_seconds?: number; expires_at?: number } = {};
        if (opts.expiresAt) {
          body.expires_at = parsePositiveNumber(opts.expiresAt, "--expires-at");
        } else {
          body.ttl_seconds = parsePositiveNumber(opts.ttlSeconds ?? DEFAULT_SHARE_TTL_SECONDS, "--ttl-seconds");
        }
        const share = await apiRequest<ReleaseShare>(
          `/api/apps/${appId}/releases/${releaseId}/shares/${shareId}`,
          { method: "PATCH", body },
        );
        if (opts.json) {
          console.log(JSON.stringify(share, null, 2));
          return;
        }
        console.log(`Updated release share ${share.id}`);
        console.log(`  expires_at: ${new Date(share.expires_at).toISOString()}`);
      },
    );

  releases
    .command("revoke-share <appIdOrSlug> <releaseId> <shareId>")
    .description("Revoke a public release share.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        shareId: string,
        opts: { json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const res = await apiRequest<{ ok: boolean; id: string; revoked_at: number }>(
          `/api/apps/${appId}/releases/${releaseId}/shares/${shareId}`,
          { method: "DELETE" },
        );
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(`Revoked release share ${res.id}`);
        console.log(`  revoked_at: ${new Date(res.revoked_at).toISOString()}`);
      },
    );
}

async function resolveAppId(slugOrId: string): Promise<string> {
  if (slugOrId.length === 36 && slugOrId.split("-").length === 5) {
    return slugOrId;
  }
  const res = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const match = res.apps.find((a) => a.slug === slugOrId);
  if (!match) {
    console.error(`No app with slug '${slugOrId}'.`);
    process.exit(1);
  }
  return match.id;
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return Math.floor(parsed);
}
