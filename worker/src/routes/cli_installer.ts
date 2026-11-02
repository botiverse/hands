/** Public bootstrap for published, self-contained CLI binaries. */
import type { Context } from "hono";
import { businessOrigin } from "../lib/origin";
import { resolvePublicChannelSlug } from "../lib/public_channel";
import { usesHostedAssets } from "../lib/release_resolver";

const safeName = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const safeRelease = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const targets = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function validNames(slug: string, channel: string): boolean {
  return safeName.test(slug) && safeName.test(channel) && channel !== "releases";
}

// Shell single-quote escaping is kept even for validated inputs so that changes to
// origin/name validation cannot silently become shell-code injection.
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function renderCliInstaller(origin: string, slug: string, channel: string): string {
  const metadataBase = `${origin}/public/v2/apps/${encodeURIComponent(slug)}/installer/${encodeURIComponent(channel)}`;
  const releaseBase = `${origin}/dl/${encodeURIComponent(slug)}/releases`;
  return `#!/bin/sh
# Hands CLI installer. Only public, fully rolled-out CLI releases are eligible.
set -eu
umask 077
fail() { printf '%s\\n' "hands installer: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required'
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'only Linux and macOS are supported' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail 'unsupported CPU architecture' ;;
esac
target="$platform-$arch"
metadata_base=${shellQuote(metadataBase)}
release_base=${shellQuote(releaseBase)}
metadata=$(curl --proto '=https' --proto-redir '=https' -fsSL "$metadata_base/$target") || fail 'could not resolve a public release for this target'
# The endpoint returns exactly three space-delimited fields, all validated again
# before they are used. Disable globbing before intentionally splitting fields.
set -f
set -- $metadata
[ "$#" -eq 3 ] || fail 'invalid release metadata'
release=$1
expected_hash=$2
expected_size=$3
case "$release" in ''|*[!a-zA-Z0-9_-]*) fail 'invalid release id' ;; esac
case "$expected_hash" in ''|*[!a-f0-9]*) fail 'invalid SHA-256' ;; esac
[ "\${#expected_hash}" -eq 64 ] || fail 'invalid SHA-256'
case "$expected_size" in ''|0|0*|*[!0-9]*) fail 'invalid byte size' ;; esac
if command -v sha256sum >/dev/null 2>&1; then
  hash_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hash_tool=shasum
else
  fail 'sha256sum or shasum is required'
fi
install_dir=\${HANDS_INSTALL_DIR:-"$HOME/.local/bin"}
install_name=\${HANDS_INSTALL_NAME:-${shellQuote(slug)}}
case "$install_dir" in /*) ;; *) fail 'HANDS_INSTALL_DIR must be an absolute path' ;; esac
case "$install_name" in ''|.|..|*[!a-zA-Z0-9._-]*) fail 'invalid HANDS_INSTALL_NAME' ;; esac
mkdir -p "$install_dir" || fail 'could not create the install directory'
destination="$install_dir/$install_name"
[ ! -d "$destination" ] || fail 'destination is a directory'
tmp=$(mktemp "$install_dir/.hands-install.XXXXXXXX") || fail 'could not create a temporary file'
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
curl --proto '=https' --proto-redir '=https' -fsSL -o "$tmp" "$release_base/$release/$target" || fail 'binary download failed'
actual_size=$(wc -c < "$tmp" | tr -d '[:space:]')
[ "$actual_size" = "$expected_size" ] || fail 'binary size does not match the release'
if [ "$hash_tool" = sha256sum ]; then
  hash_line=$(sha256sum "$tmp") || fail 'could not hash the binary'
else
  hash_line=$(shasum -a 256 "$tmp") || fail 'could not hash the binary'
fi
actual_hash=\${hash_line%% *}
[ "$actual_hash" = "$expected_hash" ] || fail 'binary SHA-256 does not match the release'
chmod 755 "$tmp" || fail 'could not make the binary executable'
mv -f "$tmp" "$destination" || fail 'could not install the binary'
trap - EXIT HUP INT TERM
printf 'Installed %s\\n' "$destination"
`;
}

export async function handleCliInstaller(c: Context<{ Bindings: Env }>): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  const channel = c.req.param("channel") ?? "";
  if (!validNames(slug, channel)) return c.text("invalid installer parameters", 400, noStore);
  let origin: string;
  try {
    origin = businessOrigin(c.env);
    if (new URL(origin).protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    return c.text("installer unavailable", 503, noStore);
  }
  return c.text(renderCliInstaller(origin, slug, channel), 200, {
    ...noStore,
    "content-type": "text/x-shellscript; charset=utf-8",
  });
}

type ReleaseRow = {
  id: string;
  build_id: string;
  artifact_mode: string | null;
  has_hosted_assets: number;
};
type AssetRow = { file_hash: string; size_bytes: number; filetype: string; artifact_kind: string };

/** Resolve a target once, then make the bootstrap fetch this immutable release. */
export async function handleCliInstallerMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  const requestedChannel = c.req.param("channel") ?? "";
  const target = c.req.param("target") ?? "";
  if (!validNames(slug, requestedChannel) || !targets.has(target)) {
    return c.text("invalid installer parameters", 400, noStore);
  }
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE slug = ?1")
    .bind(slug).first<{ id: string }>();
  if (!app) return c.text("no compatible public release", 404, noStore);
  const channel = await resolvePublicChannelSlug(c.env.DB, app.id, requestedChannel);
  const release = await c.env.DB.prepare(
    `SELECT r.id, r.build_id, b.artifact_mode,
            EXISTS (SELECT 1 FROM build_assets ba WHERE ba.build_id = b.id AND ba.artifact_kind = 'installable') AS has_hosted_assets
       FROM releases r
       JOIN channels ch ON ch.id = r.channel_id AND ch.app_id = r.app_id
       JOIN builds b ON b.id = r.build_id AND b.status = 'succeeded'
      WHERE r.app_id = ?1 AND ch.slug = ?2 AND r.product_type = 'cli-binary'
        AND r.status = 'active' AND r.hidden = 0
        AND (r.rollout_cohort_count IS NULL OR r.rollout_cohort_count >= 100)
        AND (r.availability_at IS NULL OR r.availability_at <= ?3)
        AND EXISTS (SELECT 1 FROM release_scopes s
                    WHERE s.release_id = r.id AND s.scope_type = 'full' AND s.scope_value = 'all')
      ORDER BY COALESCE(r.activated_at, r.created_at) DESC, r.id ASC LIMIT 1`,
  ).bind(app.id, channel, Date.now()).first<ReleaseRow>();
  if (!release || !safeRelease.test(release.id)) return c.text("no compatible public release", 404, noStore);

  let identity: { hash: string; size: number } | null = null;
  if (usesHostedAssets(release.artifact_mode, release.has_hosted_assets === 1)) {
    // Match the release download handler's exact primary-row ordering. Reject
    // another kind of asset instead of hashing a different row than it serves.
    const asset = await c.env.DB.prepare(
      `SELECT file_hash, size_bytes, filetype, artifact_kind FROM build_assets
        WHERE build_id = ?1 AND variant IS NULL
          AND (platform || '-' || COALESCE(arch, '')) = ?2
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(release.build_id, target).first<AssetRow>();
    if (asset && asset.filetype === "binary" && asset.artifact_kind === "installable") {
      identity = { hash: asset.file_hash, size: asset.size_bytes };
    }
  } else {
    const asset = await c.env.DB.prepare(
      "SELECT raw_sha256, raw_size_bytes FROM external_build_targets WHERE build_id = ?1 AND target = ?2",
    ).bind(release.build_id, target).first<{ raw_sha256: string; raw_size_bytes: number }>();
    if (asset) identity = { hash: asset.raw_sha256, size: asset.raw_size_bytes };
  }
  if (!identity) return c.text("no compatible public release", 404, noStore);
  if (!/^[a-f0-9]{64}$/u.test(identity.hash) || !Number.isSafeInteger(identity.size) || identity.size <= 0) {
    return c.text("invalid artifact identity", 409, noStore);
  }
  return c.text(`${release.id} ${identity.hash} ${identity.size}\n`, 200, noStore);
}
