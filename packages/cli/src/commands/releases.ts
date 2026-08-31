/**
 * `quiver releases` — release operations that are not part of build publish.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { apiRequest, QuiverApiError } from "../lib/api.js";
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
  expires_at: number | null;
  revoked_at: number | null;
}

interface ReleaseScope {
  scope_type: string;
  scope_value: string;
}

// Response shapes below follow docs/google-play-distribution-design.md plus the
// server-frozen envelopes: distributions items key the channel as `provider`,
// play-status returns `{ play: null }` before the first promotion, and Play
// write commands return a flat `{ receipt_id, edit_id, track, version_code,
// revision, rollout_percent? }`.

interface DistributionChannel {
  provider: string;
  state: string;
  track?: string | null;
  version_code?: number | null;
  rollout_percent?: number | null;
}

interface PlayDistributionState {
  track?: string | null;
  version_code?: number | null;
  rollout_percent?: number | null;
  last_edit_id?: string | null;
  last_receipt_id?: string | null;
}

interface PlayWriteResult {
  receipt_id: string;
  edit_id?: string | null;
  track?: string | null;
  version_code?: number | null;
  revision?: number;
  rollout_percent?: number | null;
}

interface ReleaseReceipt {
  id: string;
  kind: string;
  action?: string | null;
  verdict?: string | null;
  result?: string | null;
  created_at?: number | null;
}

const PLAY_TRACKS = new Set(["internal", "closed", "production"]);

function parsePlayTrack(value: string): string {
  const track = value.trim();
  if (!PLAY_TRACKS.has(track)) {
    throw new Error("--track must be one of: internal, closed, production");
  }
  return track;
}

function parsePlayVersionCode(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--to-version-code must be a positive integer");
  }
  return parsed;
}

/**
 * Fetch the release detail only for its optimistic-concurrency revision; a
 * missing/invalid revision refuses the Play write, same as update/publish.
 */
async function fetchReleaseRevision(appId: string, releaseId: string): Promise<number> {
  const detail = await apiRequest<{ release?: { revision?: unknown } }>(
    `/api/apps/${appId}/releases/${releaseId}`,
  );
  return releaseRevision(detail.release?.revision);
}

/**
 * Map the fail-closed Play write error model ({error: {code, gate, message,
 * receipt_id}}) onto a plain Error so the CLI exits non-zero with the gate
 * name verbatim and never auto-retries or prints partial output.
 */
function playWriteError(action: string, err: unknown): Error {
  if (err instanceof QuiverApiError) {
    const info = (err.body as { error?: Record<string, unknown> } | undefined)?.error;
    if (info && typeof info === "object") {
      const code = typeof info.code === "string" ? info.code : "unknown_error";
      const message = typeof info.message === "string" ? info.message : err.message;
      const receiptId = typeof info.receipt_id === "string" ? info.receipt_id : null;
      const receiptNote = receiptId ? ` (failed-closed receipt ${receiptId})` : "";
      if (code === "gate_failed") {
        const gate = typeof info.gate === "string" ? info.gate : "unknown";
        return new Error(`Play ${action} blocked by gate ${gate}: ${message}${receiptNote}`);
      }
      if (code === "edit_conflict" || code === "version_conflict") {
        return new Error(
          `Play ${action} failed (${code}): ${message}. Not retried automatically; resolve the conflict and re-run the command.`,
        );
      }
      return new Error(`Play ${action} failed (${code}): ${message}${receiptNote}`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

const RELEASE_SCOPE_TYPES = new Set(["full", "platform", "user_cohort", "ip_range", "device_group"]);

function collectRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeDeviceGroupIds(values: string[] | undefined, flag: string): string[] {
  const normalized = (values ?? []).map((value) => value.trim());
  if (normalized.some((value) => !value)) {
    throw new Error(`${flag} requires a non-empty group id`);
  }
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw new Error(`${flag} may not repeat the same group id`);
  }
  return unique.sort();
}

function normalizeStoredScopes(raw: unknown): ReleaseScope[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("publish requires a non-empty stored release scope set; refusing publish");
  }
  const scopes = raw.map((entry, index) => {
    const scope = entry as Partial<ReleaseScope> | null;
    const scopeType = typeof scope?.scope_type === "string" ? scope.scope_type.trim() : "";
    const scopeValue = typeof scope?.scope_value === "string" ? scope.scope_value.trim() : "";
    if (!scopeType || !scopeValue || !RELEASE_SCOPE_TYPES.has(scopeType)) {
      throw new Error(`stored release scope at index ${index} is empty or unsupported; refusing publish`);
    }
    if (scopeType === "full" && scopeValue !== "all") {
      throw new Error("stored full release scope must be exactly full:all; refusing publish");
    }
    return { scope_type: scopeType, scope_value: scopeValue };
  });
  const keys = scopes.map((scope) => `${scope.scope_type}\u0000${scope.scope_value}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("stored release scope set contains duplicates; refusing publish");
  }
  const hasFull = scopes.some((scope) => scope.scope_type === "full");
  if (hasFull && scopes.some((scope) => scope.scope_type !== "full" && scope.scope_type !== "device_group")) {
    throw new Error("stored full release scope may be combined only with device groups; refusing publish");
  }
  return scopes.sort((left, right) => {
    const leftRank = left.scope_type === "full" ? 0 : left.scope_type === "device_group" ? 1 : 2;
    const rightRank = right.scope_type === "full" ? 0 : right.scope_type === "device_group" ? 1 : 2;
    return leftRank - rightRank || left.scope_type.localeCompare(right.scope_type) || left.scope_value.localeCompare(right.scope_value);
  });
}

function parseRolloutPercent(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--rollout-percent must be an integer from 0 to 100");
  }
  return parsed;
}

function releaseRevision(raw: unknown): number {
  if (!Number.isInteger(raw) || Number(raw) < 0) {
    throw new Error("release detail is missing a valid revision; refusing mutation");
  }
  return Number(raw);
}

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
        revision: number;
      };
      console.log(`Release ${r.id}`);
      console.log(`  status:  ${r.status}`);
      console.log(`  revision: ${r.revision}`);
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
    .option("--full", "Reset release scope to full:all.", false)
    .option(
      "--always-include-group <groupId>",
      "Always include a device group alongside the full percentage rollout. Repeatable.",
      collectRepeated,
    )
    .option("--rollout-percent <percent>", "Set the stable full-scope rollout percentage (0-100).")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        opts: {
          changelog?: string[];
          changelogFile?: string[];
          deviceGroup?: string;
          full?: boolean;
          alwaysIncludeGroup?: string[];
          rolloutPercent?: string;
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
        const alwaysIncludeGroups = normalizeDeviceGroupIds(
          opts.alwaysIncludeGroup,
          "--always-include-group",
        );
        if (opts.deviceGroup && (opts.full || alwaysIncludeGroups.length > 0)) {
          throw new Error("--device-group cannot be combined with --full or --always-include-group");
        }
        const rolloutPercent = opts.rolloutPercent === undefined
          ? undefined
          : parseRolloutPercent(opts.rolloutPercent);
        if (
          changelog === undefined &&
          !opts.deviceGroup &&
          !opts.full &&
          alwaysIncludeGroups.length === 0 &&
          rolloutPercent === undefined
        ) {
          throw new Error(
            "nothing to update: pass --changelog(-file), a scope option, or --rollout-percent",
          );
        }
        const body: Record<string, unknown> = {};
        if (changelog !== undefined) body.changelog = changelog;
        if (opts.deviceGroup) {
          body.scopes = [{ scope_type: "device_group", scope_value: opts.deviceGroup }];
        } else if (opts.full || alwaysIncludeGroups.length > 0) {
          body.scopes = [
            { scope_type: "full", scope_value: "all" },
            ...alwaysIncludeGroups.map((groupId) => ({
              scope_type: "device_group",
              scope_value: groupId,
            })),
          ];
        }
        if (rolloutPercent !== undefined) body.rollout_cohort_count = rolloutPercent === 100 ? null : rolloutPercent;
        const detail = await apiRequest<{ release?: { revision?: unknown } }>(
          `/api/apps/${appId}/releases/${releaseId}`,
        );
        body.expected_revision = releaseRevision(detail.release?.revision);
        const updated = await apiRequest<Record<string, unknown>>(
          `/api/apps/${appId}/releases/${releaseId}`,
          { method: "PATCH", body },
        );
        if (opts.json) {
          console.log(JSON.stringify(updated, null, 2));
          return;
        }
        const updates = [
          changelog !== undefined ? `changelog${langs.length ? ` (${langs.join(", ")})` : ""}` : "",
          opts.deviceGroup ? `scope=device_group:${opts.deviceGroup}` : "",
          opts.full || alwaysIncludeGroups.length > 0
            ? `scope=full:all${alwaysIncludeGroups.map((groupId) => `+device_group:${groupId}`).join("")}`
            : "",
          rolloutPercent !== undefined ? `rollout=${rolloutPercent}%` : "",
        ].filter(Boolean);
        console.log(`Updated release ${releaseId} ${updates.join(" ")}.`);
      },
    );

  releases
    .command("publish <appIdOrSlug> <releaseId>")
    .description("Publish a draft release (the explicit human/agent step after changelog review).")
    .option(
      "--device-group <groupId>",
      "Assert the exact stored device-group set before activation. Repeatable.",
      collectRepeated,
    )
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      releaseId: string,
      opts: { deviceGroup?: string[]; json?: boolean },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const detail = await apiRequest<{
        release?: { revision?: unknown };
        scopes?: unknown;
      }>(
        `/api/apps/${appId}/releases/${releaseId}`,
      );
      const scopes = normalizeStoredScopes(detail.scopes);
      const expectedRevision = releaseRevision(detail.release?.revision);
      const assertedGroups = normalizeDeviceGroupIds(opts.deviceGroup, "--device-group");
      if (opts.deviceGroup !== undefined) {
        const storedGroups = scopes
          .filter((scope) => scope.scope_type === "device_group")
          .map((scope) => scope.scope_value)
          .sort();
        if (
          assertedGroups.length !== storedGroups.length ||
          assertedGroups.some((groupId, index) => groupId !== storedGroups[index])
        ) {
          throw new Error(
            `--device-group assertions [${assertedGroups.join(", ")}] do not match stored [${storedGroups.join(", ")}]`,
          );
        }
      }
      const result = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/releases/${releaseId}/publish`,
        {
          method: "POST",
          body: {
            expected_scopes: scopes,
            expected_revision: expectedRevision,
          },
        },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Published release ${releaseId} with ${scopes.length} exact scope${scopes.length === 1 ? "" : "s"}.`);
    });

  releases
    .command("share <appIdOrSlug> <releaseId>")
    .description("Create a revocable public share page for a release (permanent until revoked by default).")
    .option("--ttl-seconds <seconds>", "Optional share lifetime in seconds.")
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
        } else if (opts.ttlSeconds !== undefined) {
          body.ttl_seconds = parsePositiveNumber(opts.ttlSeconds, "--ttl-seconds");
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
        console.log(`  expires_at: ${share.expires_at === null ? "never" : new Date(share.expires_at).toISOString()}`);
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
          const state = share.revoked_at
            ? "revoked"
            : share.expires_at !== null && Date.now() >= share.expires_at
              ? "expired"
              : "active";
          console.log(`${share.id}  ${state}  expires=${share.expires_at === null ? "never" : new Date(share.expires_at).toISOString()}`);
        }
      },
    );

  releases
    .command("update-share <appIdOrSlug> <releaseId> <shareId>")
    .description("Renew or change a public release share expiration; omit expiry to leave it unchanged.")
    .option("--ttl-seconds <seconds>", "New lifetime in seconds from now.")
    .option("--expires-at <millis>", "Absolute expiration as Unix milliseconds.")
    .option("--never-expires", "Make the share permanent until revoked.", false)
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        releaseId: string,
        shareId: string,
        opts: { ttlSeconds?: string; expiresAt?: string; neverExpires?: boolean; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const body: { ttl_seconds?: number; expires_at?: number | null } = {};
        if (opts.neverExpires && (opts.expiresAt !== undefined || opts.ttlSeconds !== undefined)) {
          throw new Error("--never-expires cannot be combined with --expires-at or --ttl-seconds");
        }
        if (opts.expiresAt) {
          body.expires_at = parsePositiveNumber(opts.expiresAt, "--expires-at");
        } else if (opts.neverExpires) {
          body.expires_at = null;
        } else if (opts.ttlSeconds !== undefined) {
          body.ttl_seconds = parsePositiveNumber(opts.ttlSeconds, "--ttl-seconds");
        } else {
          throw new Error("nothing to update: pass --ttl-seconds, --expires-at, or --never-expires");
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
        console.log(`  expires_at: ${share.expires_at === null ? "never" : new Date(share.expires_at).toISOString()}`);
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

  releases
    .command("rebind-share <appIdOrSlug> <shareId>")
    .description("Rebind an unrevoked public share to another active release in the same app and channel.")
    .requiredOption("--from <releaseId>", "Expected current release UUID from a fresh share list.")
    .requiredOption("--to <releaseId>", "Target active release UUID.")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      shareId: string,
      opts: { from: string; to: string; json?: boolean },
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{
        id: string;
        previous_release_id: string;
        release_id: string;
        target: { version_name: string; version_code: number; file_hash: string | null };
      }>(`/api/apps/${appId}/shares/${shareId}/rebind`, {
        method: "POST",
        body: { expected_release_id: opts.from, target_release_id: opts.to },
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Rebound release share ${result.id}`);
      console.log(`  release: ${result.previous_release_id} -> ${result.release_id}`);
      console.log(`  target:  ${result.target.version_name} (${result.target.version_code})`);
      console.log(`  sha256:  ${result.target.file_hash ?? "unavailable"}`);
    });

  releases
    .command("distributions <appIdOrSlug> <releaseId>")
    .description("List distribution channels and state for a release (Hands + Google Play).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, releaseId: string, opts: { json?: boolean }, command: Command) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ distributions: DistributionChannel[] }>(
        `/api/apps/${appId}/releases/${releaseId}/distributions`,
      );
      // Honor the root `--json` global as well as the subcommand flag (task #140 contract).
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.distributions.length === 0) {
        console.log("No distribution channels.");
        return;
      }
      for (const channel of res.distributions) {
        const details = [
          channel.track ? `track=${channel.track}` : "",
          channel.version_code != null ? `versionCode=${channel.version_code}` : "",
          channel.rollout_percent != null ? `rollout=${channel.rollout_percent}%` : "",
        ].filter(Boolean).join("  ");
        console.log(`${channel.provider}  ${channel.state}${details ? `  ${details}` : ""}`);
      }
    });

  releases
    .command("play-status <appIdOrSlug> <releaseId>")
    .description("Show the current Google Play state for a release (track, versionCode, rollout).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, releaseId: string, opts: { json?: boolean }, command: Command) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ play: PlayDistributionState | null }>(
        `/api/apps/${appId}/releases/${releaseId}/distributions/play`,
      );
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const play = res.play;
      if (!play) {
        console.log("No Play distribution yet.");
        return;
      }
      console.log(`Google Play state for release ${releaseId}`);
      console.log(`  track:        ${play.track ?? "(none)"}`);
      console.log(`  versionCode:  ${play.version_code ?? "(none)"}`);
      console.log(`  rollout:      ${play.rollout_percent == null ? "(not started)" : `${play.rollout_percent}%`}`);
      console.log(`  last edit:    ${play.last_edit_id ?? "(none)"}`);
      console.log(`  last receipt: ${play.last_receipt_id ?? "(none)"}`);
    });

  releases
    .command("play-promote <appIdOrSlug> <releaseId>")
    .description("Promote the release's accepted AAB to a Google Play track (publisher role; fail-closed gates, no auto-retry).")
    .requiredOption("--track <track>", "Play track: internal, closed, or production.")
    .option("--rollout-percent <percent>", "Staged rollout percentage (0-100).")
    .requiredOption("--note <note>", "Approval note written into the promotion receipt's approvals (required, non-empty).")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      releaseId: string,
      opts: { track: string; rolloutPercent?: string; note: string; json?: boolean },
      command: Command,
    ) => {
      const track = parsePlayTrack(opts.track);
      const rolloutPercent = opts.rolloutPercent === undefined
        ? undefined
        : parseRolloutPercent(opts.rolloutPercent);
      const appId = await resolveAppId(appIdOrSlug);
      const body: Record<string, unknown> = {
        track,
        expected_revision: await fetchReleaseRevision(appId, releaseId),
        approval: { note: opts.note },
      };
      if (rolloutPercent !== undefined) body.rollout_percent = rolloutPercent;
      let res: PlayWriteResult;
      try {
        res = await apiRequest<PlayWriteResult>(
          `/api/apps/${appId}/releases/${releaseId}/distributions/play/promote`,
          { method: "POST", body },
        );
      } catch (err) {
        throw playWriteError("promote", err);
      }
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`Promoted release ${releaseId} to Google Play.`);
      console.log(`  receipt:     ${res.receipt_id}`);
      console.log(`  play edit:   ${res.edit_id ?? "unavailable"}`);
      console.log(`  track:       ${res.track ?? track}`);
      console.log(`  versionCode: ${res.version_code ?? "unavailable"}`);
      if (res.rollout_percent != null) console.log(`  rollout:     ${res.rollout_percent}%`);
    });

  releases
    .command("play-halt <appIdOrSlug> <releaseId>")
    .description("Halt the staged Google Play rollout for a release (publisher role; no auto-retry).")
    .requiredOption("--note <note>", "Approval note written into the promotion receipt's approvals (required, non-empty).")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      releaseId: string,
      opts: { note: string; json?: boolean },
      command: Command,
    ) => {
      const appId = await resolveAppId(appIdOrSlug);
      const body: Record<string, unknown> = {
        expected_revision: await fetchReleaseRevision(appId, releaseId),
        approval: { note: opts.note },
      };
      let res: PlayWriteResult;
      try {
        res = await apiRequest<PlayWriteResult>(
          `/api/apps/${appId}/releases/${releaseId}/distributions/play/halt`,
          { method: "POST", body },
        );
      } catch (err) {
        throw playWriteError("halt", err);
      }
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`Halted the Google Play rollout for release ${releaseId}.`);
      console.log(`  receipt:     ${res.receipt_id}`);
      console.log(`  play edit:   ${res.edit_id ?? "unavailable"}`);
      console.log(`  track:       ${res.track ?? "(unknown)"}`);
      console.log(`  versionCode: ${res.version_code ?? "unavailable"}`);
      if (res.rollout_percent != null) console.log(`  rollout:     ${res.rollout_percent}%`);
    });

  releases
    .command("play-rollback <appIdOrSlug> <releaseId>")
    .description("Republish a previous stable versionCode on Google Play (Play has no in-place downgrade; publisher role).")
    .requiredOption("--to-version-code <versionCode>", "Previous stable versionCode to republish at a higher versionCode.")
    .requiredOption("--note <note>", "Approval note written into the promotion receipt's approvals (required, non-empty).")
    .option("--json", "Output JSON.", false)
    .action(async (
      appIdOrSlug: string,
      releaseId: string,
      opts: { toVersionCode: string; note: string; json?: boolean },
      command: Command,
    ) => {
      const toVersionCode = parsePlayVersionCode(opts.toVersionCode);
      const appId = await resolveAppId(appIdOrSlug);
      const body: Record<string, unknown> = {
        to_version_code: toVersionCode,
        expected_revision: await fetchReleaseRevision(appId, releaseId),
        approval: { note: opts.note },
      };
      let res: PlayWriteResult;
      try {
        res = await apiRequest<PlayWriteResult>(
          `/api/apps/${appId}/releases/${releaseId}/distributions/play/rollback`,
          { method: "POST", body },
        );
      } catch (err) {
        throw playWriteError("rollback", err);
      }
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`Rolled back release ${releaseId} on Google Play to versionCode ${toVersionCode}.`);
      console.log(`  receipt:     ${res.receipt_id}`);
      console.log(`  play edit:   ${res.edit_id ?? "unavailable"}`);
      console.log(`  track:       ${res.track ?? "(unknown)"}`);
      console.log(`  versionCode: ${res.version_code ?? "unavailable"}`);
      if (res.rollout_percent != null) console.log(`  rollout:     ${res.rollout_percent}%`);
    });

  releases
    .command("receipts <appIdOrSlug> <releaseId>")
    .description("List the immutable receipt chain for a release (acceptance + Play promotions).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, releaseId: string, opts: { json?: boolean }, command: Command) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ receipts: ReleaseReceipt[] }>(
        `/api/apps/${appId}/releases/${releaseId}/receipts`,
      );
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.receipts.length === 0) {
        console.log("No receipts.");
        return;
      }
      for (const receipt of res.receipts) {
        const outcome = receipt.verdict ?? receipt.result ?? "";
        const action = receipt.action ? `/${receipt.action}` : "";
        const created = receipt.created_at == null ? "" : `  ${new Date(receipt.created_at).toISOString()}`;
        console.log(`${receipt.id}  ${receipt.kind}${action}  ${outcome}${created}`);
      }
    });
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
