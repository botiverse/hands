/**
 * ReleaseAssetUploader — shared file-drop + upload + register UI for one
 * release's binary assets.
 *
 * Used in two places:
 *   - pages/Releases.tsx → NewReleaseDialog (step 3, before publish)
 *   - components/ReleaseAssetsPanel.tsx (the panel below each ReleaseRow
 *     for adding more assets after publish)
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
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectContent,
  SelectItem,
} from "raft-ui";
import {
  createBuildAsset,
  deleteBuildAsset,
  listBuildAssets,
  uploadApk,
  type BuildAsset,
} from "../lib/api";
import { useToast } from "./Toast";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { BuildAssetIdentitySummary } from "./BuildAssetIdentitySummary";
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
      toast.show({ kind: "success", title: "Asset removed" });
      refresh();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Delete failed",
        description: (e as Error).message,
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
        <div className="mb-3 text-xs text-slate-500">
          {existing.length} asset{existing.length === 1 ? "" : "s"} ·{" "}
          {formatBuildAssetSize(totalBytes)} total
        </div>
      )}

      {props.variant === "panel" && existing.length > 0 && (
        <div className="mb-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-left text-slate-500">
                <th className="py-1 pr-3 font-normal">Asset</th>
                <th className="py-1 pr-3 font-normal">Kind</th>
                <th className="py-1 pr-3 font-normal">Platform</th>
                <th className="py-1 pr-3 font-normal">Arch</th>
                <th className="py-1 pr-3 font-normal">Size</th>
                <th className="py-1 pr-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {existing.map((a: BuildAsset) => {
                const filename = buildAssetFilename(a);
                return (
                  <tr key={a.id} className="border-b border-slate-50 align-top">
                    <td className="min-w-[16rem] py-2 pr-3">
                      <div className="break-all font-mono text-slate-800">
                        {filename}
                      </div>
                      <div className="mt-0.5 break-all font-mono text-[10px] text-slate-400">
                        {a.id}
                      </div>
                    </td>
                    <td className="py-2 pr-3 font-mono">
                      <div>{a.artifact_kind}</div>
                      <div className="text-[10px] text-slate-400">
                        {a.filetype}
                      </div>
                    </td>
                    <td className="py-2 pr-3 font-mono">{a.platform}</td>
                    <td className="py-2 pr-3 font-mono">{a.arch ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">
                      {formatBuildAssetSize(a.size_bytes)}
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <Button
                        variant="outline"
                        className="text-[10px]"
                        aria-label={`Remove ${filename}`}
                        onClick={() => setRemoveTarget(a)}
                        disabled={remove.isPending}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`cursor-pointer rounded border-2 border-dashed p-4 text-center text-xs transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-50 text-blue-700"
            : "border-slate-200 text-slate-500 hover:border-slate-400"
        }`}
      >
        Drop APK / dmg / deb / exe / rn-bundle here, or click to choose.
        Multiple files OK.
      </div>
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
        title="Remove asset registration?"
        objectLabel={removeTarget ? buildAssetFilename(removeTarget) : ""}
        objectSummary={
          removeTarget ? (
            <BuildAssetIdentitySummary asset={removeTarget} />
          ) : undefined
        }
        body={
          <>
            Removing this asset detaches it from the build and release. The
            build and release remain available.{" "}
            The uploaded file is also kept, so this action does not reclaim its
            storage.
          </>
        }
        confirmLabel="Remove asset"
        confirmKind="danger"
        pending={remove.isPending}
        {...(removeTarget
          ? {
              objectHint: `${removeTarget.artifact_kind} · ${removeTarget.platform}${
                removeTarget.arch ? `/${removeTarget.arch}` : ""
              } · ${removeTarget.filetype} · ${formatBuildAssetSize(
                removeTarget.size_bytes,
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
  const [editing, setEditing] = useState(false);
  const canEdit = pending.status === "pending";
  const detectedSummary = [
    pending.platform,
    pending.arch,
    pending.variant,
    pending.filetype,
  ].filter(Boolean).join(" / ");

  return (
    <div className="text-xs bg-slate-50 rounded-sm p-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            pending.status === "done"
              ? "bg-green-500"
              : pending.status === "error"
                ? "bg-red-500"
                : "bg-blue-500 animate-pulse"
          }`}
        />
        <span className="font-mono truncate flex-1 min-w-0">
          {pending.file.name}
        </span>
        <span className="font-mono text-[11px] text-slate-600 whitespace-nowrap">
          {detectedSummary}
        </span>
        {canEdit && (
          <Button
            variant="link"
            size="sm"
            type="button"
            className="text-[11px]"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Edit metadata"}
          </Button>
        )}
        {pending.status === "error" && (
          <span className="text-red-600 text-[10px] truncate max-w-[20ch]">
            {pending.error}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-slate-400 hover:text-red-600 text-xs"
          onClick={onRemove}
          aria-label="Dismiss"
        >
          ✕
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
              {KNOWN_PLATFORMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="py-0.5! text-xs!"
            placeholder="arch (optional)"
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
              {KNOWN_FILETYPES.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
