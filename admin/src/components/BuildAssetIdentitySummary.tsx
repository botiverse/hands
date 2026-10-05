import { CopyableCode, CopyableCodeAction, CopyableCodeRoot } from "raft-ui";
import type { BuildAsset } from "../lib/api";
import {
  buildAssetFilename,
  formatBuildAssetExactSize,
} from "../lib/buildAssetDisplay";

function CopyableAssetValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <>
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="min-w-0">
        <CopyableCodeRoot size="sm" className="w-full">
          <CopyableCode className="min-w-0 font-mono text-[11px] text-foreground-strong">
            {value}
          </CopyableCode>
          <CopyableCodeAction aria-label={`Copy ${label}`} />
        </CopyableCodeRoot>
      </dd>
    </>
  );
}

function AssetValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-foreground-strong">{value}</dd>
    </>
  );
}

export function BuildAssetIdentitySummary({ asset }: { asset: BuildAsset }) {
  return (
    <dl
      className="grid min-w-0 grid-cols-1 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-4"
      data-testid="build-asset-identity-summary"
    >
      <AssetValue label="filename" value={buildAssetFilename(asset)} />
      <CopyableAssetValue label="asset id" value={asset.id} />
      <CopyableAssetValue label="build id" value={asset.build_id} />
      <AssetValue label="kind" value={asset.artifact_kind} />
      <AssetValue label="platform" value={asset.platform} />
      <AssetValue label="arch" value={asset.arch ?? "—"} />
      <AssetValue label="variant" value={asset.variant ?? "—"} />
      <AssetValue label="filetype" value={asset.filetype} />
      <AssetValue
        label="size"
        value={formatBuildAssetExactSize(asset.size_bytes)}
      />
      <CopyableAssetValue label="sha256" value={asset.file_hash} />
      <CopyableAssetValue label="r2 key" value={asset.r2_key} />
    </dl>
  );
}
