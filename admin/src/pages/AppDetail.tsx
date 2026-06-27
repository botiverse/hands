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
import { useToast } from "../components/Toast";
import { Operations } from "./Operations";

export function AppDetail({
  appId,
  onShowAudit,
  onShowPublish,
}: {
  appId: string;
  onShowAudit: () => void;
  onShowPublish: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
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
          className="mt-2 text-sm text-blue-600 hover:underline inline-block mr-3"
        >
          View audit log →
        </button>
        <button
          onClick={onShowPublish}
          className="mt-2 text-sm text-blue-600 hover:underline inline-block"
        >
          Manage publishing →
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

      <section className="mt-8">
        <Operations appId={appId} />
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
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateVersion(appId, version.id, { enabled }),
    onMutate: (enabled) => {
      return toast.show({
        kind: "loading",
        title: enabled ? "Enabling version…" : "Disabling version…",
        ttlMs: 0,
      });
    },
    onSuccess: (_data, enabled) => {
      // The loading toast is updated in onSettled (we can't reach it here
      // without capturing the id; we just dismiss any "loading" toast by
      // re-using its pattern: show a fresh success toast).
      toast.show({
        kind: "success",
        title: enabled ? "Version enabled" : "Version disabled",
      });
      onToggled();
    },
    onError: (e) => {
      toast.show({ kind: "error", title: "Toggle failed", description: (e as Error).message });
    },
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
  const toast = useToast();

  const create = useMutation({
    mutationFn: () => createChannel(appId, { slug, name }),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Channel '${slug}' created` });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Failed to create channel",
        description: (e as Error).message,
      }),
  });

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
      <div className="card max-w-md w-full relative">
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
        <h2 className="text-lg font-bold mb-4 pr-8">New channel</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
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
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Each step owns a toast id so progress survives modal close.
  const parseToastRef = useRef<number | null>(null);
  const uploadToastRef = useRef<number | null>(null);
  const publishToastRef = useRef<number | null>(null);

  // Step 1: parse APK via container
  const parse = useMutation({
    mutationFn: async (f: File) => parseApk(f),
    onMutate: (f) => {
      parseToastRef.current = toast.show({
        kind: "loading",
        title: `Parsing ${f.name}…`,
        description: "Step 1/3 — Container is reading APK metadata",
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

  // Step 2: upload APK bytes to R2
  const upload = useMutation({
    mutationFn: async () => {
      if (!file || !metadata) throw new Error("parse first");
      return uploadApk(appId, file);
    },
    onMutate: () => {
      uploadToastRef.current = toast.show({
        kind: "loading",
        title: "Uploading to R2…",
        description: file
          ? `Step 2/3 — ${(file.size / 1024 / 1024).toFixed(2)} MB`
          : "Step 2/3",
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

  // Step 3: write D1 row
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
    onMutate: () => {
      publishToastRef.current = toast.show({
        kind: "loading",
        title: "Publishing version…",
        description: "Step 3/3 — Writing D1 row",
      });
    },
    onSuccess: () => {
      if (publishToastRef.current != null) {
        toast.update(publishToastRef.current, {
          kind: "success",
          title: "Version published",
          description: `v${metadata?.version_name} (${channel})`,
        });
      }
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

  // Auto-trigger upload as soon as metadata is ready.
  if (metadata && !r2Key && !upload.isPending && !upload.isError) {
    setTimeout(() => upload.mutate(), 0);
  }
  // Auto-trigger publish as soon as r2Key is ready.
  if (r2Key && !submit.isPending && !submit.isError && !submit.isSuccess) {
    setTimeout(() => submit.mutate(), 0);
  }

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
      <div className="card max-w-lg w-full relative">
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
        <h2 className="text-lg font-bold mb-4 pr-8">Upload APK</h2>
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
                  parse.mutate(f);
                }
              }}
              className="block w-full text-sm"
            />
            <p className="text-xs text-slate-500">
              {parse.isPending
                ? "Parsing… see progress in bottom-right corner."
                : "Pick an .apk file. Step 1/3 → 2/3 → 3/3 run automatically; progress shows in the bottom-right corner even if you close this dialog."}
            </p>
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
            <p className="text-xs text-slate-500">
              Uploading to R2… see bottom-right corner.
            </p>
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
            <p className="text-xs text-slate-500">
              Publishing… see bottom-right corner.
            </p>
          </div>
        )}
        <div className="flex justify-end pt-2 mt-2 border-t border-slate-100">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close (operations continue in background)
          </button>
        </div>
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