import { errorMessage } from "../lib/errorMessage";
/**
 * ReleaseAssetUploader — shared file-drop + upload + register UI for one
 * release's binary assets.
 *
 * Used in two places:
 *   - pages/Releases.tsx → NewReleaseDialog (step 3, before publish)
 *   - components/ReleaseAssetsPanel.tsx (the Files section of an open
 *     release, for adding more assets after publish)
 *
 * The user drops N files; for each one we:
 *   1. POST /api/apps/:appId/upload        (raw bytes → R2 + sha256)
 *   2. POST /api/apps/:appId/builds/:buildId/assets  (register the asset)
 *   3. Mark the per-file status pending → uploading → registering → done/error
 *
 * On failure the file stays visible with an error chip; the surrounding
 * context (dialog or row) decides whether to abort or continue.
 */

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, X } from "lucide-react";
import {
  Button,
  ListRow,
  ListRowBody,
  ListRowGroup,
  ListRowSubtitle,
  ListRowTitle,
  Text,
  TextLink,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectList,
  SelectContent,
  SelectItem,
} from "@botiverse/raft-ui";
import {
  createBuildAsset,
  deleteBuildAsset,
  getBuildAssetDownloadUrl,
  listBuildAssets,
  uploadApk,
  type BuildAsset,
} from "../lib/api";
import { useToast } from "./Toast";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { BuildAssetIdentitySummary } from "./BuildAssetIdentitySummary";
import { useLocale, useText } from "../lib/locale";
import {
  KNOWN_FILETYPES,
  KNOWN_PLATFORMS,
  pendingFileFromFile,
  type PendingFile,
} from "../lib/releaseFileDetect";
import {
  buildAssetFilename,
  formatBuildAssetSize,
} from "../lib/buildAssetDisplay";

interface BaseProps {
  appId: string;
  buildId: string;
  /** Used as the default platform when a file's filename has no hint. */
  productTypeHint: string;
  /** Called after a successful upload+register so the parent can refresh. */
  onUploaded?: () => void;
}

interface PanelProps extends BaseProps {
  variant: "panel";
  releaseId: string;
}

interface DialogProps extends BaseProps {
  variant: "dialog";
  /**
   * When true, the uploader accumulates files locally and surfaces status via
   * `onFilesChanged` — the parent triggers uploads itself (after the release
   * is created, since the build_id doesn't exist yet during step 3).
   */
  deferUpload?: boolean;
  /** Called whenever the local file list or status changes. */
  onFilesChanged?: (files: PendingFile[]) => void;
}

type Props = PanelProps | DialogProps;

export function ReleaseAssetUploader(props: Props) {
  const t = useText();
  const { locale } = useLocale();
  const { appId, buildId, productTypeHint, onUploaded } = props;
  const deferUpload = props.variant === "dialog" && props.deferUpload === true;
  const onFilesChanged =
    props.variant === "dialog" ? props.onFilesChanged : undefined;
  const qc = useQueryClient();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [removeTarget, setRemoveTarget] = useState<BuildAsset | null>(null);
  // Per-asset in-flight guard so a double click does not request two presigned URLs.
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set());
  const download = async (asset: BuildAsset) => {
    setDownloading((current) => new Set(current).add(asset.id));
    try {
      const { download_url } = await getBuildAssetDownloadUrl(appId, buildId, asset.id);
      window.location.href = download_url;
    } catch (e) {
      toast.show({ kind: "error", title: t("Download failed", "下载失败"), description: errorMessage(e) });
    } finally {
      setDownloading((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    }
  };

  // Panel-only: query existing assets so the user sees what's already there.
  const assetsQuery = useQuery({
    queryKey: ["build-assets", appId, buildId],
    queryFn: () => listBuildAssets(appId, buildId),
    enabled: props.variant === "panel",
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["build-assets", appId, buildId] });
    if (props.variant === "panel") {
      qc.invalidateQueries({ queryKey: ["release-detail", props.releaseId] });
      qc.invalidateQueries({ queryKey: ["releases", appId] });
    }
    onUploaded?.();
  }, [qc, appId, buildId, props, onUploaded]);

  const remove = useMutation({
    mutationFn: (assetId: string) => deleteBuildAsset(appId, buildId, assetId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Asset removed", "文件已移除") });
      refresh();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Delete failed", "删除失败"),
        description: errorMessage(e),
      }),
  });

  const ingestFiles = useCallback(
    async (files: File[]) => {
      const initial: PendingFile[] = files.map((f) =>
        pendingFileFromFile(f, productTypeHint),
      );
      setPending((cur) => {
        const next = [...cur, ...initial];
        onFilesChanged?.(next);
        return next;
      });

      if (deferUpload) {
        // Parent will run uploads + register after the release is created.
        return;
      }

      for (const slot of initial) {
        const setStatus = (
          status: PendingFile["status"],
          extra?: Partial<PendingFile>,
        ) => {
          setPending((cur) => {
            const next = cur.map((p) =>
              p === slot ? { ...p, status, ...extra } : p,
            );
            onFilesChanged?.(next);
            return next;
          });
        };
        try {
          setStatus("uploading");
          const uploaded = await uploadApk(appId, slot.file);
          setStatus("registering");
          const asset = await createBuildAsset(appId, buildId, {
            platform: slot.platform,
            arch: slot.arch,
            variant: slot.variant,
            filetype: slot.filetype,
            r2_key: uploaded.r2_key,
            file_hash: uploaded.file_hash,
            size_bytes: uploaded.size_bytes,
          });
          setStatus("done", { assetId: asset.id });
        } catch (e) {
          setStatus("error", { error: (e as Error).message });
        }
      }
      refresh();
    },
    [appId, buildId, productTypeHint, refresh, onFilesChanged, deferUpload],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void ingestFiles(files);
    },
    [ingestFiles],
  );

  const existing = assetsQuery.data?.assets ?? [];
  const totalBytes = existing.reduce((s, a) => s + a.size_bytes, 0);

  return (
    <div>
      {props.variant === "panel" && existing.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          <Text.Sans size="small" variant="muted">
            {t(`${existing.length} asset${existing.length === 1 ? "" : "s"} · ${formatBuildAssetSize(totalBytes, locale)} total`, `${existing.length} 个文件 · 共 ${formatBuildAssetSize(totalBytes, locale)}`)}
          </Text.Sans>
          <ListRowGroup>
            {existing.map((a: BuildAsset) => {
              const filename = buildAssetFilename(a, locale);
              return (
                <ListRow key={a.id} variant="plain" interactive={false}>
                  <ListRowBody>
                    <ListRowTitle className="font-mono text-footnote [overflow-wrap:anywhere] whitespace-normal">{filename}</ListRowTitle>
                    <ListRowSubtitle className="whitespace-normal font-mono">
                      {[formatBuildAssetSize(a.size_bytes, locale), `${a.platform}${a.arch ? `/${a.arch}` : ""}`, a.filetype, a.artifact_kind].join(" · ")}
                    </ListRowSubtitle>
                    {/* Actions sit under the name so they stay on screen on a phone. */}
                    <div className="mt-1 flex gap-4 text-footnote">
                      <TextLink
                        aria-label={t(`Download ${filename}`, `下载 ${filename}`)}
                        onClick={() => void download(a)}
                        disabled={downloading.has(a.id)}
                      >
                        {downloading.has(a.id) ? t("Preparing…", "准备中…") : t("Download", "下载")}
                      </TextLink>
                      <TextLink
                        aria-label={t(`Remove ${filename}`, `移除 ${filename}`)}
                        onClick={() => setRemoveTarget(a)}
                        disabled={remove.isPending}
                      >
                        {t("Remove", "移除")}
                      </TextLink>
                    </div>
                  </ListRowBody>
                </ListRow>
              );
            })}
          </ListRowGroup>
        </div>
      )}

      {/* Drop zone */}
      <button
        type="button"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-container border border-dashed px-4 py-5 text-center text-footnote transition-colors ${
          dragOver
            ? "border-line-strong bg-fill-muted text-foreground"
            : "border-line-muted text-foreground-muted hover:border-line-strong hover:text-foreground"
        }`}
      >
        <Upload aria-hidden="true" className="size-4 shrink-0" />
        {t("Drop APK / dmg / deb / exe here, or click to choose. Multiple files OK.", "将 APK / dmg / deb / exe 文件拖到此处，或点击选择。可选择多个文件。")}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void ingestFiles(files);
          e.target.value = "";
        }}
      />

      {pending.length > 0 && (
        <div className="mt-3 space-y-1">
          {pending.map((p, idx) => (
            <PendingFileRow
              key={`${p.file.name}-${idx}`}
              pending={p}
              onChange={(patch) =>
                setPending((cur) =>
                  cur.map((x, i) => (i === idx ? { ...x, ...patch } : x)),
                )
              }
              onRemove={() =>
                setPending((cur) => cur.filter((_, i) => i !== idx))
              }
            />
          ))}
        </div>
      )}

      <ConfirmActionDialog
        open={removeTarget !== null}
        title={t("Remove asset registration?", "移除文件登记？")}
        objectLabel={removeTarget ? buildAssetFilename(removeTarget, locale) : ""}
        objectSummary={
          removeTarget ? (
            <BuildAssetIdentitySummary asset={removeTarget} />
          ) : undefined
        }
        body={
          <>
            {t("Removing this asset detaches it from the build and release. The build and release remain available. The uploaded file is also kept, so this action does not reclaim its storage.", "移除此文件会解除它与构建及版本的关联。构建和版本仍然可用；已上传的文件也会保留，因此不会释放存储空间。")}
          </>
        }
        confirmLabel={t("Remove asset", "移除文件")}
        confirmKind="danger"
        pending={remove.isPending}
        {...(removeTarget
          ? {
              objectHint: `${removeTarget.artifact_kind} · ${removeTarget.platform}${
                removeTarget.arch ? `/${removeTarget.arch}` : ""
              } · ${removeTarget.filetype} · ${formatBuildAssetSize(
                removeTarget.size_bytes, locale,
              )}`,
            }
          : {})}
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.id);
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

export function PendingFileRow({
  pending,
  onChange,
  onRemove,
}: {
  pending: PendingFile;
  onChange: (patch: Partial<PendingFile>) => void;
  onRemove: () => void;
}) {
  const t = useText();
  const [editing, setEditing] = useState(false);
  const canEdit = pending.status === "pending";
  const detectedSummary = [
    pending.platform,
    pending.arch,
    pending.variant,
    pending.filetype,
  ].filter(Boolean).join(" / ");

  return (
    <div className="rounded-container border border-line-hairline p-2 text-footnote">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            pending.status === "done"
              ? "bg-success"
              : pending.status === "error"
                ? "bg-danger"
                : "bg-info animate-pulse"
          }`}
        />
        <span className="font-mono truncate flex-1 min-w-0">
          {pending.file.name}
        </span>
        <span className="font-mono text-[11px] text-foreground whitespace-nowrap">
          {detectedSummary}
        </span>
        {canEdit && (
          <TextLink
            type="button"
            className="text-[11px]"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? t("Done", "完成") : t("Edit metadata", "编辑元数据")}
          </TextLink>
        )}
        {pending.status === "error" && (
          <span className="text-danger text-[10px] truncate max-w-[20ch]">
            {pending.error && errorMessage(pending.error)}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-md"
          onClick={onRemove}
          aria-label={t("Dismiss", "关闭")}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {editing && canEdit && (
        <div className="grid grid-cols-3 gap-2 mt-2">
          <Select
            items={Object.fromEntries(KNOWN_PLATFORMS.map((p) => [p, p]))}
            value={pending.platform}
            onValueChange={(v) => onChange({ platform: v as string })}
          >
            <SelectTrigger className="py-0.5! text-xs!">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
              {KNOWN_PLATFORMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectList>
            </SelectContent>
          </Select>
          <Input
            className="py-0.5! text-xs!"
            placeholder={t("arch (optional)", "架构（可选）")}
            value={pending.arch ?? ""}
            onChange={(e) => onChange({ arch: e.target.value || null })}
          />
          <Select
            items={Object.fromEntries(KNOWN_FILETYPES.map((f) => [f, f]))}
            value={pending.filetype}
            onValueChange={(v) => onChange({ filetype: v as string })}
          >
            <SelectTrigger className="py-0.5! text-xs!">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
              {KNOWN_FILETYPES.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectList>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
