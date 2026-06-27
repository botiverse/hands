import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseApk,
  uploadApk,
  createVersion,
  listProductTypes,
  listReleaseTypes,
  type Channel,
  type ProductType,
  type ReleaseType,
} from "../lib/api";
import { useToast } from "./Toast";

/**
 * UploadDialog — 4-step channel-first wizard for Android APK upload + publish.
 *
 * Steps:
 *   1. Target:   channel + product_type + release_type dropdowns
 *                (product_types and release_types fetched from app's
 *                product_types / release_types endpoints — backend
 *                seeded by AppCreationWizard handleCreateApp)
 *   2. File:     pick APK. Container parses via parseApk() — auto-extracts
 *                package_name, version_name, version_code, signature, etc.
 *                (still using legacy /api/parse-apk; will switch to
 *                /api/builds push when expert lands Task #10)
 *   3. Details:  version name/code (auto-suggested from parsed metadata),
 *                changelog, should_force_update, availability_at, provenance
 *   4. Review + Publish: summary card → click to upload to R2 + create
 *                release (legacy /api/apps/:id/upload + /api/apps/:id/versions
 *                for now; will switch to /api/builds POST + /api/releases
 *                POST when expert lands Tasks #10 + #11)
 */

type Step = 1 | 2 | 3 | 4;

export function UploadDialog({
  appId,
  channels,
  onClose,
  onCreated,
}: {
  appId: string;
  channels: Channel[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  // App-level product_types + release_types (loaded once, used in step 1)
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });
  const releaseTypes = useQuery({
    queryKey: ["release-types", appId],
    queryFn: () => listReleaseTypes(appId),
  });

  // Wizard state
  const [step, setStep] = useState<Step>(1);
  const [channelSlug, setChannelSlug] = useState(channels[0]?.slug ?? "");
  const [productTypeName, setProductTypeName] = useState("android-apk");
  const [releaseTypeName, setReleaseTypeName] = useState("stable");
  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<any>(null);
  const [r2Key, setR2Key] = useState<string | null>(null);
  const [versionName, setVersionName] = useState("");
  const [versionCode, setVersionCode] = useState<number>(0);
  const [changelog, setChangelog] = useState("");
  const [shouldForceUpdate, setShouldForceUpdate] = useState(false);
  const [availabilityAt, setAvailabilityAt] = useState<string>("");
  const [provenance, setProvenance] = useState({
    git_commit: "",
    git_branch: "",
    ci_url: "",
    source: "web",
  });
  const fileRef = useRef<HTMLInputElement>(null);

  // Toast ids so progress survives modal close
  const parseToastRef = useRef<number | null>(null);
  const uploadToastRef = useRef<number | null>(null);
  const publishToastRef = useRef<number | null>(null);

  // ===== Step 1→2: Parse APK via container =====
  const parse = useMutation({
    mutationFn: async (f: File) => parseApk(f),
    onMutate: (f) => {
      parseToastRef.current = toast.show({
        kind: "loading",
        title: `Parsing ${f.name}...`,
        description: "Step 2/4 - Container is reading APK metadata",
      });
    },
    onSuccess: (m) => {
      if (parseToastRef.current != null) {
        toast.update(parseToastRef.current, {
          kind: "success",
          title: "APK parsed",
          description: `${m.package_name} v${m.version_name} (${(m.size_bytes / 1024 / 1024).toFixed(2)} MB)`,
        });
      }
      setMetadata(m);
      setVersionName(m.version_name);
      setVersionCode(m.version_code);
    },
    onError: (e) => {
      if (parseToastRef.current != null) {
        toast.update(parseToastRef.current, {
          kind: "error",
          title: "APK parse failed",
          description: (e as Error).message,
        });
      } else {
        toast.show({
          kind: "error",
          title: "APK parse failed",
          description: (e as Error).message,
        });
      }
    },
  });

  // ===== Step 2→3: Upload APK bytes to R2 =====
  const upload = useMutation({
    mutationFn: async () => {
      if (!file || !metadata) throw new Error("parse first");
      return uploadApk(appId, file);
    },
    onMutate: () => {
      uploadToastRef.current = toast.show({
        kind: "loading",
        title: "Uploading to R2...",
        description: file
          ? `Step 2/4 - ${(file.size / 1024 / 1024).toFixed(2)} MB`
          : "Step 2/4",
      });
    },
    onSuccess: (r) => {
      if (uploadToastRef.current != null) {
        toast.update(uploadToastRef.current, {
          kind: "success",
          title: "Uploaded to R2",
          description: r.r2_key,
        });
      }
      setR2Key(r.r2_key);
    },
    onError: (e) => {
      if (uploadToastRef.current != null) {
        toast.update(uploadToastRef.current, {
          kind: "error",
          title: "Upload to R2 failed",
          description: (e as Error).message,
        });
      } else {
        toast.show({
          kind: "error",
          title: "Upload to R2 failed",
          description: (e as Error).message,
        });
      }
    },
  });

  // ===== Step 3→4: Create version (publish) =====
  const submit = useMutation({
    mutationFn: () => {
      if (!metadata || !r2Key) throw new Error("upload first");
      return createVersion(appId, {
        channel: channelSlug,
        version_name: versionName,
        version_code: versionCode,
        package_name: metadata.package_name,
        signature_sha256: metadata.signature_sha256,
        min_sdk: metadata.min_sdk,
        target_sdk: metadata.target_sdk,
        size_bytes: metadata.size_bytes,
        file_hash: metadata.file_hash_sha256,
        r2_key: r2Key,
        changelog: changelog.trim() || undefined,
        should_force_update: shouldForceUpdate,
        availability_at: availabilityAt
          ? new Date(availabilityAt).getTime()
          : undefined,
        provenance: {
          ...provenance,
          git_commit: provenance.git_commit.trim() || undefined,
          git_branch: provenance.git_branch.trim() || undefined,
          ci_url: provenance.ci_url.trim() || undefined,
        },
      });
    },
    onMutate: () => {
      publishToastRef.current = toast.show({
        kind: "loading",
        title: "Publishing version...",
        description: "Step 4/4 - Writing D1 row",
      });
    },
    onSuccess: () => {
      if (publishToastRef.current != null) {
        toast.update(publishToastRef.current, {
          kind: "success",
          title: "Version published",
          description: `v${versionName} (${channelSlug})`,
        });
      }
      qc.invalidateQueries({ queryKey: ["versions", appId] });
      qc.invalidateQueries({ queryKey: ["product-types", appId] });
      onCreated();
    },
    onError: (e) => {
      if (publishToastRef.current != null) {
        toast.update(publishToastRef.current, {
          kind: "error",
          title: "Publish failed",
          description: (e as Error).message,
        });
      } else {
        toast.show({
          kind: "error",
          title: "Publish failed",
          description: (e as Error).message,
        });
      }
    },
  });

  // Auto-advance stepper when each mutation completes
  useEffect(() => {
    if (metadata && step === 2 && !upload.isPending && !upload.isError) {
      setTimeout(() => upload.mutate(), 0);
    }
  }, [metadata, step]);
  useEffect(() => {
    if (r2Key && step === 3) {
      // Stay on step 3 so user can edit version_name/code/changelog before publish
    }
  }, [r2Key, step]);

  const selectedProductType: ProductType | undefined = productTypes.data?.product_types.find(
    (pt) => pt.name === productTypeName,
  );
  const selectedReleaseType: ReleaseType | undefined = releaseTypes.data?.release_types.find(
    (rt) => rt.name === releaseTypeName,
  );

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="card max-w-2xl w-full relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-4 text-xs text-slate-500">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center font-medium ${
                  n === step
                    ? "bg-blue-600 text-white"
                    : n < step
                      ? "bg-blue-100 text-blue-700"
                      : "bg-slate-100 text-slate-500"
                }`}
              >
                {n < step ? "✓" : n}
              </div>
              <span className={n === step ? "font-medium text-slate-700" : ""}>
                {n === 1
                  ? "Target"
                  : n === 2
                    ? "File"
                    : n === 3
                      ? "Details"
                      : "Review"}
              </span>
              {n < 4 && <span className="text-slate-300 mx-1">→</span>}
            </div>
          ))}
        </div>

        {/* Step 1: Target */}
        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Publish new version - Target</h2>
            <div className="space-y-3">
              <div>
                <label className="label">Channel *</label>
                <select
                  className="input"
                  value={channelSlug}
                  onChange={(e) => setChannelSlug(e.target.value)}
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.slug}>
                      {c.slug} — {c.name}
                      {c.bundle_id ? ` (${c.bundle_id})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Product type *</label>
                <select
                  className="input"
                  value={productTypeName}
                  onChange={(e) => setProductTypeName(e.target.value)}
                  disabled={productTypes.isLoading}
                >
                  {productTypes.data?.product_types.map((pt) => (
                    <option key={pt.id} value={pt.name}>
                      {pt.display_name} ({pt.name})
                    </option>
                  ))}
                  {(!productTypes.data?.product_types ||
                    productTypes.data.product_types.length === 0) && (
                    <option value="android-apk">android-apk</option>
                  )}
                </select>
                {selectedProductType && (
                  <p className="text-xs text-slate-500 mt-1">
                    {selectedProductType.description}
                  </p>
                )}
              </div>
              <div>
                <label className="label">Release type *</label>
                <select
                  className="input"
                  value={releaseTypeName}
                  onChange={(e) => setReleaseTypeName(e.target.value)}
                  disabled={releaseTypes.isLoading}
                >
                  {releaseTypes.data?.release_types.map((rt) => (
                    <option key={rt.id} value={rt.name}>
                      {rt.display_name} ({rt.name})
                    </option>
                  ))}
                  {(!releaseTypes.data?.release_types ||
                    releaseTypes.data.release_types.length === 0) && (
                    <option value="stable">stable</option>
                  )}
                </select>
                {selectedReleaseType && (
                  <p className="text-xs text-slate-500 mt-1">
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                      style={{ backgroundColor: selectedReleaseType.color ?? "#6b7280" }}
                    />
                    {selectedReleaseType.description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-100">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStep(2)}
                disabled={!channelSlug || !productTypeName || !releaseTypeName}
              >
                Next: pick file →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: File */}
        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Publish new version - File</h2>
            <div className="space-y-3">
              <input
                ref={fileRef}
                type="file"
                accept=".apk"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setFile(f);
                    parse.mutate(f);
                  }
                }}
                className="block w-full text-sm"
              />
              <p className="text-xs text-slate-500">
                Pick an .apk file. The container will parse it automatically
                (package, version, signature, native codes). You can edit
                version_name + version_code on the next step.
              </p>
              {parse.isPending && (
                <p className="text-xs text-blue-600">Parsing... see bottom-right corner.</p>
              )}
              {metadata && (
                <div className="border-t border-slate-100 pt-3">
                  <dl className="text-sm space-y-1">
                    <Row k="Package" v={metadata.package_name} mono />
                    <Row k="Version" v={`${metadata.version_name} (code ${metadata.version_code})`} mono />
                    <Row k="minSdk / targetSdk" v={`${metadata.min_sdk ?? "?"} / ${metadata.target_sdk ?? "?"}`} />
                    <Row k="Signature" v={metadata.signature_sha256.slice(0, 32) + "…"} mono />
                    <Row k="Size" v={`${(metadata.size_bytes / 1024 / 1024).toFixed(2)} MB`} />
                    <Row k="SHA-256" v={metadata.file_hash_sha256.slice(0, 32) + "…"} mono />
                  </dl>
                </div>
              )}
            </div>
            <div className="flex justify-between pt-4 mt-4 border-t border-slate-100">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep(1)}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStep(3)}
                disabled={!metadata}
              >
                Next: details →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Details */}
        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Publish new version - Details</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Version name *</label>
                  <input
                    className="input font-mono"
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label">Version code *</label>
                  <input
                    type="number"
                    className="input font-mono"
                    value={versionCode}
                    onChange={(e) => setVersionCode(Number(e.target.value))}
                    required
                  />
                </div>
              </div>
              <div>
                <label className="label">Changelog (markdown, optional)</label>
                <textarea
                  className="input font-mono text-xs min-h-[80px]"
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  placeholder={"## What's new\n- Fixed login bug\n- Updated onboarding flow"}
                />
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shouldForceUpdate}
                    onChange={(e) => setShouldForceUpdate(e.target.checked)}
                  />
                  Force update (clients must install, no skip)
                </label>
                <div>
                  <label className="label">Availability (leave blank for immediate)</label>
                  <input
                    type="datetime-local"
                    className="input"
                    value={availabilityAt}
                    onChange={(e) => setAvailabilityAt(e.target.value)}
                  />
                </div>
                <details className="text-xs">
                  <summary className="text-slate-500 cursor-pointer hover:text-slate-700">
                    Provenance (git / CI)
                  </summary>
                  <div className="space-y-1 mt-2 pl-3 border-l-2 border-slate-100">
                    <input
                      className="input text-xs font-mono"
                      placeholder="git commit (sha)"
                      value={provenance.git_commit}
                      onChange={(e) => setProvenance({ ...provenance, git_commit: e.target.value })}
                    />
                    <input
                      className="input text-xs font-mono"
                      placeholder="git branch"
                      value={provenance.git_branch}
                      onChange={(e) => setProvenance({ ...provenance, git_branch: e.target.value })}
                    />
                    <input
                      className="input text-xs font-mono"
                      placeholder="ci url"
                      value={provenance.ci_url}
                      onChange={(e) => setProvenance({ ...provenance, ci_url: e.target.value })}
                    />
                    <select
                      className="input text-xs"
                      value={provenance.source}
                      onChange={(e) => setProvenance({ ...provenance, source: e.target.value })}
                    >
                      <option value="web">web</option>
                      <option value="cli">cli</option>
                      <option value="ci">ci</option>
                    </select>
                  </div>
                </details>
              </div>
            </div>
            <div className="flex justify-between pt-4 mt-4 border-t border-slate-100">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep(2)}
                disabled={upload.isPending}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setStep(4);
                  // Trigger upload if not yet uploaded
                  if (!r2Key && !upload.isPending && !upload.isError) {
                    upload.mutate();
                  }
                }}
                disabled={!versionName || !versionCode || upload.isPending}
              >
                Next: review →
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Review + Publish */}
        {step === 4 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Publish new version - Review</h2>
            <div className="space-y-3">
              <div className="card !p-3 bg-slate-50 border-slate-200">
                <SummaryRow k="Channel" v={channelSlug} />
                <SummaryRow k="Product type" v={productTypeName} />
                <SummaryRow
                  k="Release type"
                  v={releaseTypeName}
                  dot={selectedReleaseType?.color ?? undefined}
                />
                <SummaryRow k="Version" v={`${versionName} (code ${versionCode})`} mono />
                <SummaryRow
                  k="Package"
                  v={metadata?.package_name ?? "?"}
                  mono
                />
                <SummaryRow
                  k="Size"
                  v={metadata ? `${(metadata.size_bytes / 1024 / 1024).toFixed(2)} MB` : "?"}
                />
                {changelog && (
                  <SummaryRow k="Changelog" v={`${changelog.split("\n").length} lines`} />
                )}
                <SummaryRow
                  k="Force update"
                  v={shouldForceUpdate ? "Yes" : "No"}
                />
                {availabilityAt && (
                  <SummaryRow k="Scheduled for" v={availabilityAt} />
                )}
                {(provenance.git_commit ||
                  provenance.git_branch ||
                  provenance.ci_url) && (
                  <SummaryRow k="Provenance" v="set (expand details)" />
                )}
              </div>

              {!r2Key && (
                <p className="text-xs text-blue-600">
                  Uploading to R2... {upload.isPending ? "(in progress)" : "(queued)"}
                </p>
              )}
              {r2Key && (
                <p className="text-xs text-green-600">
                  ✓ Uploaded to R2: <code>{r2Key}</code>
                </p>
              )}
            </div>

            <div className="flex justify-between pt-4 mt-4 border-t border-slate-100">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep(3)}
                disabled={submit.isPending}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn-primary w-full ml-2"
                disabled={
                  submit.isPending ||
                  submit.isSuccess ||
                  !r2Key ||
                  !channelSlug ||
                  !versionName ||
                  !versionCode
                }
                onClick={() => submit.mutate()}
              >
                {submit.isPending
                  ? "Publishing..."
                  : submit.isSuccess
                    ? "✓ Published"
                    : `Publish to ${channelSlug}`}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              You can close this dialog — progress will continue in the
              bottom-right corner.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 text-slate-500">{k}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{v}</dd>
    </div>
  );
}

function SummaryRow({
  k,
  v,
  mono,
  dot,
}: {
  k: string;
  v: string;
  mono?: boolean | undefined;
  dot?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-32 text-slate-500 text-xs">{k}</div>
      {dot && (
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: dot }}
        />
      )}
      <div className={mono ? "font-mono text-xs" : "text-sm"}>{v}</div>
    </div>
  );
}