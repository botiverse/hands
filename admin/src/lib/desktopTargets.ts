import type { BuildAsset } from "./api";

/** Desktop targets Hands publishes (worker lib/desktop_manifest.ts). */
const TARGET_LABELS: Record<string, { en: string; zh: string }> = {
  "darwin-arm64": { en: "macOS · Apple silicon", zh: "macOS · Apple 芯片" },
  "darwin-x64": { en: "macOS · Intel", zh: "macOS · Intel" },
  "win32-x64": { en: "Windows · x64", zh: "Windows · x64" },
  "win32-arm64": { en: "Windows · Arm", zh: "Windows · Arm" },
  "linux-x64": { en: "Linux · x64", zh: "Linux · x64" },
  "linux-arm64": { en: "Linux · Arm", zh: "Linux · Arm" },
};

const DESKTOP_KINDS = new Set(["desktop-manifest", "desktop-archive"]);

export type DesktopTargetGroup = {
  /** e.g. "darwin-arm64". */
  target: string;
  label: { en: string; zh: string };
  /** The sealed manifest is what makes a target live for updates. */
  manifest: BuildAsset | null;
  archive: BuildAsset | null;
  installers: BuildAsset[];
  /** Live: its manifest is sealed, so the update endpoint serves it. */
  live: boolean;
  /** Bytes of the archive and installers (the manifest's files are stored once per app). */
  sizeBytes: number;
};

export function isDesktopBuild(assets: readonly BuildAsset[]): boolean {
  return assets.some((a) => DESKTOP_KINDS.has(a.artifact_kind));
}

/**
 * A desktop build's assets grouped by target (platform-arch), in a stable
 * order: known targets first in the order above, then any other. Assets
 * that belong to no desktop target are returned separately.
 */
export function groupDesktopTargets(assets: readonly BuildAsset[]): { targets: DesktopTargetGroup[]; other: BuildAsset[] } {
  const byTarget = new Map<string, DesktopTargetGroup>();
  const other: BuildAsset[] = [];
  for (const asset of assets) {
    const isDesktopKind = DESKTOP_KINDS.has(asset.artifact_kind) || asset.artifact_kind === "installable";
    if (!isDesktopKind || !asset.arch || !["darwin", "win32", "linux"].includes(asset.platform)) {
      other.push(asset);
      continue;
    }
    const target = `${asset.platform}-${asset.arch}`;
    let group = byTarget.get(target);
    if (!group) {
      group = {
        target,
        label: TARGET_LABELS[target] ?? { en: target, zh: target },
        manifest: null,
        archive: null,
        installers: [],
        live: false,
        sizeBytes: 0,
      };
      byTarget.set(target, group);
    }
    if (asset.artifact_kind === "desktop-manifest") {
      group.manifest = asset;
      group.live = true;
    } else if (asset.artifact_kind === "desktop-archive") {
      group.archive = asset;
      group.sizeBytes += asset.size_bytes;
    } else {
      group.installers.push(asset);
      group.sizeBytes += asset.size_bytes;
    }
  }
  const order = Object.keys(TARGET_LABELS);
  const rank = (t: string) => (order.indexOf(t) === -1 ? order.length : order.indexOf(t));
  const targets = [...byTarget.values()].sort((a, b) => rank(a.target) - rank(b.target) || a.target.localeCompare(b.target));
  return { targets, other };
}

/** What each desktop asset is, in words. */
export function desktopAssetRole(asset: BuildAsset): { en: string; zh: string } {
  if (asset.artifact_kind === "desktop-manifest") return { en: "Update manifest", zh: "更新清单" };
  if (asset.artifact_kind === "desktop-archive") return { en: "Full archive", zh: "完整压缩包" };
  return { en: "Installer", zh: "安装包" };
}
