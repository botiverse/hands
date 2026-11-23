/**
 * Hands does not stream stored files through the Worker: downloads are 302s to signed
 * R2 URLs (lib/r2_presign.ts redirectToR2). This was settled more than once and kept
 * coming back one route at a time, so it is enforced here: any route that returns an
 * R2 object's body must be listed below with its reason, and unless the file is small
 * by nature it must try redirectToR2 first (streaming then only happens where R2
 * signing is not configured, i.e. local development).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** file:function -> why streaming is allowed there. "small:" means no redirect is required. */
const ALLOWED: Record<string, string> = {
  "routes/apps.ts:handlePublicAppIcon": "small: an app icon of a few KB",
  "routes/shares.ts:handlePublicReleaseShareIcon": "small: a share page icon of a few KB",
  "routes/electron_metadata.ts:handleGetElectronMetadata": "small: a replaced latest*.yml, read by an admin",
  "routes/electron.ts:handleElectronGenericAsset": "latest*.yml is served here (small, may be overridden); every other file redirects",
  "routes/external_dl.ts:serveHostedAsset": "fallback when R2 signing is not configured",
  "routes/builds.ts:handleDownloadBuildAsset": "fallback when R2 signing is not configured",
  "routes/public_v2.ts:handleInternalR2Download": "fallback when R2 signing is not configured",
  "routes/public_v2.ts:handlePublicR2Download": "fallback when R2 signing is not configured",
  "routes/public_v2.ts:serveSignedDesktopFile": "fallback when R2 signing is not configured",
  "routes/feedback.ts:handleDownloadFeedbackAttachment": "fallback when R2 signing is not configured",
  "routes/reporter_feedback.ts:handleDownloadReporterAttachment": "fallback when R2 signing is not configured",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every `new Response(<x>.body` / `c.body(<x>.body` with the function it sits in. */
function streamingSites() {
  const sites: Array<{ key: string; fnBody: string }> = [];
  for (const path of files(SRC)) {
    const text = readFileSync(path, "utf8");
    // R2 objects are bound as `object` across the Worker (R2Object / R2ObjectBody);
    // other Response bodies (static assets, upstream fetches) are not stored files.
    const pattern = /(?:new Response\(\s*|\bc\.body\(\s*)(?:object|r2Object)\??\.body\b(?!\))/g;
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index);
      const fns = [...before.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)];
      const last = fns.at(-1);
      const name = last?.[1] ?? "<module>";
      const start = last?.index ?? 0;
      sites.push({ key: `${relative(SRC, path)}:${name}`, fnBody: text.slice(start, match.index) });
    }
  }
  return sites;
}

describe("stored files are not proxied through the Worker", () => {
  const sites = streamingSites();

  it("finds the streaming sites it is meant to police", () => {
    expect(sites.length).toBeGreaterThan(5);
  });

  it("allows streaming only where listed", () => {
    const unlisted = [...new Set(sites.map((s) => s.key))].filter((key) => !(key in ALLOWED));
    expect(unlisted, "redirect with redirectToR2 (lib/r2_presign.ts), or list it here with a reason").toEqual([]);
  });

  it("tries a signed R2 redirect first wherever a file can be large", () => {
    const missing = sites.filter((s) => !ALLOWED[s.key]?.startsWith("small:") && !/redirectToR2\(|presignR2DownloadUrl\(/.test(s.fnBody))
      .map((s) => s.key);
    expect(missing).toEqual([]);
  });
});
