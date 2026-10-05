/**
 * ReleaseAssetsPanel — thin wrapper around ReleaseAssetUploader for use
 * below each ReleaseRow.
 *
 * Shows existing assets + a drop zone to attach more binaries (Android
 * multi-arch, Electron multi-OS, RN bundle). After the new release flow
 * (commit for task #30), most uploads happen in the dialog itself; this
 * panel is still useful for late additions ("oh I forgot arm64").
 */

import { ReleaseAssetUploader } from "./ReleaseAssetUploader";

interface Props {
  appId: string;
  releaseId: string;
  buildId: string;
  productTypeHint: string;
}

export function ReleaseAssetsPanel({
  appId,
  releaseId,
  buildId,
  productTypeHint,
}: Props) {
  return (
    <div className="mt-2 pt-2 border-t border-line-hairline">
      <ReleaseAssetUploader
        variant="panel"
        appId={appId}
        releaseId={releaseId}
        buildId={buildId}
        productTypeHint={productTypeHint}
      />
    </div>
  );
}
