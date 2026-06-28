import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  archiveApp,
  getAuthMe,
  listApps,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  listPublicVersions,
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
  onShowAccess,
}: {
  appId: string;
  onShowAudit: () => void;
  onShowPublish: () => void;
  onShowAccess: () => void;
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

  // (legacy UploadDialog state removed — releases are created via the Releases tab)
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

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
          className="mt-2 text-sm text-blue-600 hover:underline inline-block mr-3"
        >
          Manage publishing →
        </button>
        <button
          onClick={onShowAccess}
          className="mt-2 text-sm text-blue-600 hover:underline inline-block"
        >
          Manage access →
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
        {channels.isLoading && <p className="text-slate-500">Loading…</p>}
        <div className="space-y-2">
          {channels.data?.channels.length === 0 && (
            <p className="text-slate-500 text-sm">No channels yet.</p>
          )}
          {channels.data?.channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              onEdit={() => setEditingChannel(c)}
              busy={false}
            />
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
        {editingChannel && (
          <EditChannelDialog
            appId={appId}
            channel={editingChannel}
            onClose={() => setEditingChannel(null)}
            onSaved={() => {
              setEditingChannel(null);
              qc.invalidateQueries({ queryKey: ["channels", appId] });
            }}
          />
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Versions</h2>
          <a
            href={`/apps/${appId}/releases`}
            className="btn-primary text-sm no-underline"
            title={
              !channels.data?.channels.length
                ? "Create a channel first"
                : "Create a release + attach APK assets"
            }
          >
            + New release
          </a>
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
        {/* Legacy UploadDialog removed — create releases from the Releases tab. */}
      </section>

      <section className="mt-8">
        <Operations appId={appId} />
      </section>

      <section className="mt-8">
        <AppSettings appId={appId} app={app} />
      </section>
    </div>
  );
}

function AppSettings({
  appId,
  app,
}: {
  appId: string;
  app: ReturnType<typeof listApps> extends Promise<infer R>
    ? R extends { apps: Array<infer A> }
      ? A | undefined
      : undefined
    : undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgRole = me.data?.account.org_role ?? null;
  const isOrgAdmin = orgRole === "owner" || orgRole === "admin";

  const [confirmArchive, setConfirmArchive] = useState(false);

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveApp(appId, { archived }),
    onSuccess: (_, archived) => {
      toast.show({
        kind: "success",
        title: archived ? "App archived" : "App unarchived",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["versions", appId] });
      qc.invalidateQueries({ queryKey: ["builds", appId] });
      qc.invalidateQueries({ queryKey: ["releases", appId] });
      setConfirmArchive(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Archive failed",
        description: (e as Error).message,
      }),
  });

  if (!app) return null;

  return (
    <div className="card !p-4 text-sm space-y-3">
      <h2 className="text-base font-semibold">Settings</h2>

      {/* Danger zone: archive / unarchive */}
      <div className="border-t border-slate-100 pt-3">
        <h3 className="text-sm font-medium text-slate-700 mb-2">
          Danger zone
        </h3>
        {!isOrgAdmin && (
          <p className="text-xs text-yellow-700 mb-2">
            ⚠ Org owner / admin required to archive.
          </p>
        )}

        <div className="flex items-center justify-between gap-2 p-3 border border-slate-200 rounded-md">
          <div>
            <div className="font-medium">
              {app.archived ? "App is archived" : "App is active"}
            </div>
            <div className="text-xs text-slate-500">
              {app.archived
                ? "Archived apps reject new uploads but remain viewable. " +
                  "Re-archive / unarchive to toggle."
                : "Active apps accept uploads + releases normally."}
            </div>
            {app.archived_at && (
              <div className="text-xs text-slate-400 mt-1">
                archived_at: {new Date(app.archived_at).toISOString()}
              </div>
            )}
          </div>
          {isOrgAdmin &&
            (confirmArchive ? (
              <div className="flex items-center gap-2">
                <button
                  className={app.archived ? "btn-secondary" : "btn-secondary"}
                  onClick={() => setConfirmArchive(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn-primary text-xs"
                  onClick={() => archive.mutate(!app.archived)}
                  disabled={archive.isPending}
                >
                  {archive.isPending
                    ? app.archived
                      ? "Unarchiving…"
                      : "Archiving…"
                    : app.archived
                      ? "Confirm unarchive"
                      : "Confirm archive"}
                </button>
              </div>
            ) : (
              <button
                className="btn-secondary text-xs"
                onClick={() => setConfirmArchive(true)}
                disabled={archive.isPending}
              >
                {app.archived ? "Unarchive" : "Archive"}
              </button>
            ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Future: default channel config, signing credential binding,
          custom domains, app ownership transfer.
        </p>
      </div>
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
        title: enabled ? "Enabling version..." : "Disabling version...",
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
          sha256: {version.signature_sha256.slice(0, 16)}...
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
  const [bundleId, setBundleId] = useState("");
  const [password, setPassword] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createChannel(appId, {
        slug,
        name,
        bundle_id: bundleId.trim() || undefined,
        password: password.trim() || undefined,
        git_url: gitUrl.trim() || undefined,
      }),
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
          <div>
            <label className="label">Bundle ID override (optional)</label>
            <input
              className="input font-mono text-xs"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="com.example.myapp.beta"
            />
          </div>
          <div>
            <label className="label">Download password (optional)</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="leave blank for no gate"
            />
          </div>
          <div>
            <label className="label">Git URL (optional)</label>
            <input
              className="input font-mono text-xs"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/foo/bar/tree/beta"
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

function ChannelRow({
  channel: c,
  onEdit,
  busy,
}: {
  channel: Channel;
  onEdit: () => void;
  busy: boolean;
}) {
  return (
    <div className="card !p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{c.name}</span>
          <span className="text-xs font-mono text-slate-500">{c.slug}</span>
          {c.bundle_id && (
            <span
              className="badge-blue text-xs font-mono"
              title="Bundle ID override"
            >
              {c.bundle_id}
            </span>
          )}
          {c.password && (
            <span
              className="badge-orange text-xs"
              title="Downloads require password"
            >
              🔒 gated
            </span>
          )}
          {c.git_url && (
            <a
              className="text-xs text-blue-600 hover:underline font-mono truncate max-w-xs"
              href={c.git_url}
              target="_blank"
              rel="noreferrer"
              title={c.git_url}
            >
              {c.git_url}
            </a>
          )}
        </div>
      </div>
      <button
        className="btn-secondary text-sm"
        onClick={onEdit}
        disabled={busy}
      >
        Edit
      </button>
    </div>
  );
}

function EditChannelDialog({
  appId,
  channel,
  onClose,
  onSaved,
}: {
  appId: string;
  channel: Channel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(channel.name);
  const [bundleId, setBundleId] = useState(channel.bundle_id ?? "");
  const [password, setPassword] = useState(channel.password ?? "");
  const [gitUrl, setGitUrl] = useState(channel.git_url ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      updateChannel(appId, channel.id, {
        name,
        bundle_id: bundleId.trim() || null,
        password: password.trim() || null,
        git_url: gitUrl.trim() || null,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Channel '${channel.slug}' saved` });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Save failed",
        description: (e as Error).message,
      }),
  });

  const remove = useMutation({
    mutationFn: () => deleteChannel(appId, channel.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Channel '${channel.slug}' deleted` });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Delete failed",
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
        <h2 className="text-lg font-bold mb-4 pr-8">Edit channel '{channel.slug}'</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="label">Slug (immutable)</label>
            <input
              className="input font-mono text-xs bg-slate-50"
              value={channel.slug}
              readOnly
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
          <div>
            <label className="label">Bundle ID override</label>
            <input
              className="input font-mono text-xs"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="com.example.myapp.beta"
            />
          </div>
          <div>
            <label className="label">Download password</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="leave blank for no gate"
            />
          </div>
          <div>
            <label className="label">Git URL</label>
            <input
              className="input font-mono text-xs"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/foo/bar/tree/beta"
            />
          </div>
          <div className="flex gap-2 justify-between pt-2 border-t border-slate-100">
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  className="text-red-600 text-sm hover:underline"
                  onClick={() => setConfirmDelete(false)}
                  disabled={remove.isPending}
                >
                  Cancel delete
                </button>
                <button
                  type="button"
                  className="bg-red-600 text-white text-sm px-3 py-1 rounded-md hover:bg-red-700"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  {remove.isPending
                    ? "Deleting…"
                    : "Confirm delete"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="text-red-600 text-sm hover:underline"
                  onClick={() => setConfirmDelete(true)}
                  disabled={save.isPending || remove.isPending}
                >
                  Delete channel
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={save.isPending}
                  >
                    {save.isPending ? "Saving…" : "Save"}
                  </button>
                </div>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

