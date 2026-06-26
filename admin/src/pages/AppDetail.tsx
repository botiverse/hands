import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import {
  listApps,
  listChannels,
  createChannel,
  listPublicVersions,
  parseApk,
  uploadApk,
  createVersion,
  updateVersion,
  type App,
  type Channel,
  type Version,
} from "../lib/api";

export function AppDetail({
  appId,
  onShowAudit,
}: {
  appId: string;
  onShowAudit: () => void;
}) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const versions = useQuery({
    queryKey: ["versions", appId],
    queryFn: () => listPublicVersions(appId),
  });

  const [showUpload, setShowUpload] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);

  return (
    <div>
      <div className="mb-6">
        <div className="text-sm text-slate-500">App</div>
        <h1 className="text-2xl font-bold">
          {app?.name ?? "..."}{" "}
          <span className="badge-blue align-middle">{app?.platform}</span>
        </h1>
        <div className="text-sm text-slate-500 font-mono">{app?.slug}</div>
        <button
          onClick={onShowAudit}
          className="mt-2 text-sm text-blue-600 hover:underline"
        >
          View audit log →
        </button>
      </div>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Channels</h2>
          <button
            className="btn-secondary text-sm"
            onClick={() => setShowCreateChannel(true)}
          >
            + New channel
          </button>
        </div>
        {channels.isLoading && <p className="text-slate-500">Loading...</p>}
        <div className="flex flex-wrap gap-2">
          {channels.data?.channels.length === 0 && (
            <p className="text-slate-500 text-sm">No channels yet.</p>
          )}
          {channels.data?.channels.map((c) => (
            <span key={c.id} className="badge-gray">
              {c.slug} · {c.name}
            </span>
          ))}
        </div>
        {showCreateChannel && (
          <CreateChannelDialog
            appId={appId}
            onClose={() => setShowCreateChannel(false)}
            onCreated={() => {
              setShowCreateChannel(false);
              qc.invalidateQueries({ queryKey: ["channels", appId] });
            }}
          />
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Versions</h2>
          <button
            className="btn-primary text-sm"
            disabled={!channels.data?.channels.length}
            onClick={() => setShowUpload(true)}
            title={
              !channels.data?.channels.length
                ? "Create a channel first"
                : "Upload a new APK"
            }
          >
            + Upload APK
          </button>
        </div>
        {versions.isLoading && <p className="text-slate-500">Loading...</p>}
        {versions.data?.versions.length === 0 && (
          <p className="text-slate-500 text-sm">
            No versions yet. Upload an APK to publish one.
          </p>
        )}
        <div className="space-y-2">
          {versions.data?.versions.map((v) => (
            <VersionRow
              key={v.id}
              version={v}
              appId={appId}
              onToggled={() =>
                qc.invalidateQueries({ queryKey: ["versions", appId] })
              }
            />
          ))}
        </div>
        {showUpload && (
          <UploadDialog
            appId={appId}
            channels={channels.data?.channels ?? []}
            onClose={() => setShowUpload(false)}
            onCreated={() => {
              setShowUpload(false);
              qc.invalidateQueries({ queryKey: ["versions", appId] });
            }}
          />
        )}
      </section>
    </div>
  );
}

function VersionRow({
  version,
  appId,
  onToggled,
}: {
  version: Version;
  appId: string;
  onToggled: () => void;
}) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateVersion(appId, version.id, { enabled }),
    onSuccess: onToggled,
  });
  return (
    <div className="card flex items-center gap-4">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">
            v{version.version_name} ({version.version_code})
          </span>
          <span className="badge-gray">{version.channel}</span>
          {version.enabled ? (
            <span className="badge-green">enabled</span>
          ) : (
            <span className="badge-gray">disabled</span>
          )}
        </div>
        <div className="text-xs text-slate-500 font-mono mt-1 truncate">
          {version.package_name} · {(version.size_bytes / 1024 / 1024).toFixed(2)} MB
        </div>
        <div className="text-xs text-slate-400 font-mono mt-0.5">
          sha256: {version.signature_sha256.slice(0, 16)}…
        </div>
      </div>
      <button
        onClick={() => toggle.mutate(!version.enabled)}
        className={version.enabled ? "btn-secondary text-sm" : "btn-primary text-sm"}
        disabled={toggle.isPending}
      >
        {version.enabled ? "Disable" : "Enable"}
      </button>
    </div>
  );
}

function CreateChannelDialog({
  appId,
  onClose,
  onCreated,
}: {
  appId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState("production");
  const [name, setName] = useState("Production");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => createChannel(appId, { slug, name }),
    onSuccess: onCreated,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10">
      <div className="card max-w-md w-full">
        <h2 className="text-lg font-bold mb-4">New channel</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            create.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="label">Slug</label>
            <input
              className="input"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={create.isPending}
            >
              {create.isPending ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UploadDialog({
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
  const [file, setFile] = useState<File | null>(null);
  const [channel, setChannel] = useState(channels[0]?.slug ?? "");
  const [metadata, setMetadata] = useState<any>(null);
  const [r2Key, setR2Key] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Step 1: parse APK via container (returns metadata: package_name, version_*, signature, file_hash, size)
  const parse = useMutation({
    mutationFn: async (f: File) => parseApk(f),
    onSuccess: (m) => setMetadata(m),
    onError: (e) => setError((e as Error).message),
  });

  // Step 2: upload APK bytes to R2 via Worker multipart endpoint
  const upload = useMutation({
    mutationFn: async () => {
      if (!file || !metadata) throw new Error("parse first");
      return uploadApk(appId, file);
    },
    onSuccess: (r) => setR2Key(r.r2_key),
    onError: (e) => setError((e as Error).message),
  });

  // Step 3: write D1 row referencing the uploaded R2 key + parsed metadata
  const submit = useMutation({
    mutationFn: () => {
      if (!metadata || !r2Key) throw new Error("upload first");
      return createVersion(appId, {
        channel,
        version_name: metadata.version_name,
        version_code: metadata.version_code,
        package_name: metadata.package_name,
        signature_sha256: metadata.signature_sha256,
        min_sdk: metadata.min_sdk,
        target_sdk: metadata.target_sdk,
        size_bytes: metadata.size_bytes,
        file_hash: metadata.file_hash_sha256,
        r2_key: r2Key,
      });
    },
    onSuccess: onCreated,
    onError: (e) => setError((e as Error).message),
  });

  const step = !metadata
    ? "parse"
    : !r2Key
      ? "upload"
      : "publish";

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10">
      <div className="card max-w-lg w-full">
        <h2 className="text-lg font-bold mb-4">Upload APK</h2>
        {!metadata ? (
          <div className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".apk"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  setError("");
                  parse.mutate(f);
                }
              }}
              className="block w-full text-sm"
            />
            {parse.isPending && (
              <p className="text-slate-500 text-sm">
                Step 1/3: Parsing APK metadata via container...
              </p>
            )}
            {error && <p className="text-red-600 text-sm">{error}</p>}
          </div>
        ) : !r2Key ? (
          <div className="space-y-3">
            <dl className="text-sm space-y-1">
              <Row k="Package" v={metadata.package_name} mono />
              <Row k="Version" v={`${metadata.version_name} (code ${metadata.version_code})`} mono />
              <Row k="minSdk / targetSdk" v={`${metadata.min_sdk ?? "?"} / ${metadata.target_sdk ?? "?"}`} />
              <Row k="Signature" v={metadata.signature_sha256.slice(0, 32) + "…"} mono />
              <Row k="Size" v={`${(metadata.size_bytes / 1024 / 1024).toFixed(2)} MB`} />
              <Row k="SHA-256" v={metadata.file_hash_sha256.slice(0, 32) + "…"} mono />
            </dl>
            <p className="text-slate-500 text-sm">
              Step 2/3: Upload APK to R2 ({file && (file.size / 1024 / 1024).toFixed(2)} MB)
            </p>
            {upload.isPending && (
              <div className="h-2 bg-slate-100 rounded overflow-hidden">
                <div className="h-full bg-blue-500 animate-pulse w-full" />
              </div>
            )}
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                onClick={() => upload.mutate()}
                className="btn-primary"
                disabled={upload.isPending}
              >
                {upload.isPending ? "Uploading..." : "Upload to R2"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <dl className="text-sm space-y-1">
              <Row k="Package" v={metadata.package_name} mono />
              <Row k="Version" v={`${metadata.version_name} (code ${metadata.version_code})`} mono />
              <Row k="R2 key" v={r2Key} mono />
            </dl>
            <div>
              <label className="label">Channel</label>
              <select
                className="input"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.slug}>
                    {c.slug} — {c.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-slate-500 text-sm">Step 3/3: Publish to D1</p>
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                onClick={() => submit.mutate()}
                className="btn-primary"
                disabled={submit.isPending}
              >
                {submit.isPending ? "Publishing..." : "Publish version"}
              </button>
            </div>
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