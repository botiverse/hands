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
  createBuildAsset,
  deleteBuildAsset,
  listBuildAssets,
  uploadApk,
  type BuildAsset,
} from "../lib/api";
import { useToast } from "./Toast";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import {
  KNOWN_FILETYPES,
  KNOWN_PLATFORMS,
  pendingFileFromFile,
  type PendingFile,
} from "../lib/releaseFileDetect";

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
          {(totalBytes / 1024 / 1024).toFixed(2)} MB total
        </div>
      )}

      {props.variant === "panel" && existing.length > 0 && (
        <table className="w-full text-xs mb-3">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal pr-2 py-1">Platform</th>
              <th className="font-normal pr-2 py-1">Arch</th>
              <th className="font-normal pr-2 py-1">Filetype</th>
              <th className="font-normal pr-2 py-1">Size</th>
              <th className="font-normal pr-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {existing.map((a: BuildAsset) => (
              <tr key={a.id} className="border-b border-slate-50">
                <td className="pr-2 py-1 font-mono">{a.platform}</td>
                <td className="pr-2 py-1 font-mono">{a.arch ?? "—"}</td>
                <td className="pr-2 py-1 font-mono">{a.filetype}</td>
                <td className="pr-2 py-1 font-mono">
                  {(a.size_bytes / 1024 / 1024).toFixed(2)} MB
                </td>
                <td className="pr-2 py-1">
                  <button
                    className="btn-secondary text-[10px]"
                    onClick={() => setRemoveTarget(a)}
                    disabled={remove.isPending}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        title="Remove asset from this release?"
        objectLabel={`${removeTarget?.platform ?? ""}${
          removeTarget?.arch ? `/${removeTarget.arch}` : ""
        } ${removeTarget?.filetype ?? ""}`}
        objectSummary={
          removeTarget ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
              <div className="text-slate-500">platform</div>
              <div>{removeTarget.platform}</div>
              <div className="text-slate-500">arch</div>
              <div>{removeTarget.arch ?? "—"}</div>
              <div className="text-slate-500">filetype</div>
              <div>{removeTarget.filetype}</div>
              <div className="text-slate-500">r2_key</div>
              <div className="truncate">{removeTarget.r2_key}</div>
            </div>
          ) : undefined
        }
        body={
          <>
            Removing this asset detaches the registration from the release.{" "}
            <strong>The release row and build metadata are kept.</strong> The
            underlying R2 binary is also kept (we never auto-delete uploaded
            blobs); if you want to reclaim the storage, delete it from R2
            separately after removing this row.
          </>
        }
        confirmLabel="Remove asset"
        confirmKind="danger"
        pending={remove.isPending}
        {...(removeTarget?.size_bytes != null && removeTarget?.r2_key
          ? {
              objectHint: `${(removeTarget.size_bytes / 1024 / 1024).toFixed(2)} MB · ${removeTarget.r2_key.slice(0, 24)}${removeTarget.r2_key.length > 24 ? "…" : ""}`,
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
    <div className="text-xs bg-slate-50 rounded p-2">
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
          <button
            type="button"
            className="text-blue-600 hover:underline text-[11px]"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Edit metadata"}
          </button>
        )}
        {pending.status === "error" && (
          <span className="text-red-600 text-[10px] truncate max-w-[20ch]">
            {pending.error}
          </span>
        )}
        <button
          className="text-slate-400 hover:text-red-600 text-xs"
          onClick={onRemove}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>

      {editing && canEdit && (
        <div className="grid grid-cols-3 gap-2 mt-2">
          <select
            className="input !py-0.5 !text-xs"
            value={pending.platform}
            onChange={(e) => onChange({ platform: e.target.value })}
          >
            {KNOWN_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            className="input !py-0.5 !text-xs"
            placeholder="arch (optional)"
            value={pending.arch ?? ""}
            onChange={(e) => onChange({ arch: e.target.value || null })}
          />
          <select
            className="input !py-0.5 !text-xs"
            value={pending.filetype}
            onChange={(e) => onChange({ filetype: e.target.value })}
          >
            {KNOWN_FILETYPES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
