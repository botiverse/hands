import type { Build, Channel } from "./api";

export type GooglePlayPackageOption = {
  packageName: string;
  source: "parsed" | "declared" | "channel";
  isMain: boolean;
};

function packageFrom(value: string): string | null {
  try {
    const metadata = JSON.parse(value);
    const name = metadata?.package_id ?? metadata?.package_name;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(name) ? name : null;
  } catch { return null; }
}

export function googlePlayPackageOptions(
  channels: Pick<Channel, "id" | "slug" | "bundle_id">[],
  builds: Pick<Build, "channel_id" | "status" | "product_type" | "parsed_metadata_json" | "build_metadata_json">[],
): GooglePlayPackageOption[] {
  const options = new Map<string, GooglePlayPackageOption>();
  const rank = { parsed: 3, declared: 2, channel: 1 };
  const add = (packageName: string | null, source: GooglePlayPackageOption["source"], isMain: boolean) => {
    if (!packageName) return;
    const existing = options.get(packageName);
    options.set(packageName, { packageName, source: existing && rank[existing.source] > rank[source] ? existing.source : source, isMain: isMain || Boolean(existing?.isMain) });
  };
  for (const channel of channels) add(packageFrom(JSON.stringify({ package_name: channel.bundle_id })), "channel", channel.slug === "main");
  for (const build of builds) {
    if (build.status !== "succeeded" || build.product_type !== "android-apk") continue;
    const isMain = channels.some((channel) => channel.id === build.channel_id && channel.slug === "main");
    add(packageFrom(build.parsed_metadata_json), "parsed", isMain);
    add(packageFrom(build.build_metadata_json), "declared", isMain);
  }
  return [...options.values()].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.packageName.localeCompare(b.packageName));
}
