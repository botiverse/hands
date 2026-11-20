/**
 * ReleaseAssetsPanel — thin wrapper around ReleaseAssetUploader for the
 * Files section of an open release.
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
    <div>
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
