import { CopyableCode, CopyableCodeAction, CopyableCodeRoot } from "raft-ui";
import type { BuildAsset } from "../lib/api";
import {
  buildAssetFilename,
  formatBuildAssetExactSize,
} from "../lib/buildAssetDisplay";
import { useText } from "../lib/locale";

function CopyableAssetValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const t = useText();
  return (
    <>
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="min-w-0">
        <CopyableCodeRoot size="sm" className="w-full">
          <CopyableCode className="min-w-0 font-mono text-[11px] text-foreground-strong">
            {value}
          </CopyableCode>
          <CopyableCodeAction aria-label={t(`Copy ${label}`, `复制${label}`)} />
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
  const t = useText();
  return (
    <dl
      className="grid min-w-0 grid-cols-1 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-4"
      data-testid="build-asset-identity-summary"
    >
      <AssetValue label={t("filename", "文件名")} value={buildAssetFilename(asset)} />
      <CopyableAssetValue label={t("asset id", "文件 ID")} value={asset.id} />
      <CopyableAssetValue label={t("build id", "构建 ID")} value={asset.build_id} />
      <AssetValue label={t("kind", "类型")} value={asset.artifact_kind} />
      <AssetValue label={t("platform", "平台")} value={asset.platform} />
      <AssetValue label={t("arch", "架构")} value={asset.arch ?? "—"} />
      <AssetValue label={t("variant", "变体")} value={asset.variant ?? "—"} />
      <AssetValue label={t("filetype", "文件类型")} value={asset.filetype} />
      <AssetValue
        label={t("size", "大小")}
        value={formatBuildAssetExactSize(asset.size_bytes)}
      />
      <CopyableAssetValue label="sha256" value={asset.file_hash} />
      <CopyableAssetValue label={t("r2 key", "R2 键")} value={asset.r2_key} />
    </dl>
  );
}
