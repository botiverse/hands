import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ConfirmActionDialog, TypedConfirmField } from "../components/ConfirmActionDialog";
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
  updateApp,
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
            app={app}
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
          <div>
            <h2 className="text-lg font-semibold">App overview</h2>
            <p className="text-xs text-slate-500">
              Versions &amp; status overview. For new releases, use the{" "}
              <a href={`/apps/${appId}/releases`} className="underline">
                Releases
              </a>{" "}
              page.
            </p>
          </div>
          {channels.data?.channels.length ? (
            <a
              href={`/apps/${appId}/releases`}
              className="btn-primary text-sm no-underline"
            >
              Publish release →
            </a>
          ) : (
            <button
              type="button"
              className="btn-primary text-sm"
              onClick={() => setShowCreateChannel(true)}
            >
              Create channel first
            </button>
          )}
        </div>
        {versions.isLoading && <p className="text-slate-500">Loading...</p>}
        {versions.data?.versions.length === 0 && (
          <p className="text-slate-500 text-sm">
            No versions yet. Use Releases → New release to publish one.
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

      {/* Default release channel picker */}
      <DefaultChannelPicker appId={appId} app={app} isOrgAdmin={isOrgAdmin} />

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
                  "You can unarchive any time to restore normal operation."
                : "Active apps accept uploads + releases normally."}
            </div>
            {app.archived_at && (
              <div className="text-xs text-slate-400 mt-1">
                archived_at: {new Date(app.archived_at).toISOString()}
              </div>
            )}
          </div>
          {isOrgAdmin && (
            <button
              className="btn-secondary text-xs"
              onClick={() => setConfirmArchive(true)}
              disabled={archive.isPending}
            >
              {app.archived ? "Unarchive" : "Archive"}
            </button>
          )}
        </div>

        <ConfirmActionDialog
          open={confirmArchive}
          title={app.archived ? "Unarchive this app?" : "Archive this app?"}
          objectLabel={app.name ?? app.slug ?? app.id}
          objectHint={`slug: ${app.slug}`}
          objectSummary={
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
              <div className="text-slate-500">id</div>
              <div>{app.id.slice(0, 8)}…</div>
              <div className="text-slate-500">slug</div>
              <div>{app.slug}</div>
              <div className="text-slate-500">status</div>
              <div>{app.archived ? "archived" : "active"}</div>
            </div>
          }
          body={
            app.archived ? (
              <>
                Unarchiving restores the app to <strong>active</strong> status.{" "}
                New uploads and releases will be accepted again.
                <br />
                <span className="text-xs text-slate-500">
                  This is a soft-delete reversal — all existing builds,
                  releases, and assets are kept as-is.
                </span>
              </>
            ) : (
              <>
                Archiving marks the app as <strong>archived (soft delete)</strong>.
                The app remains viewable in lists and admin pages, but{" "}
                <strong>new uploads are rejected</strong>.
                <br />
                <span className="text-xs text-slate-500">
                  This is reversible: you can unarchive any time. Builds,
                  releases, and assets are kept as-is. The underlying binary
                  data in R2 is not deleted.
                </span>
              </>
            )
          }
          confirmLabel={app.archived ? "Unarchive app" : "Archive app"}
          cancelLabel={app.archived ? "Keep archived" : "Keep active"}
          confirmKind="primary"
          pending={archive.isPending}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            archive.mutate(!app.archived);
            setConfirmArchive(false);
          }}
        />
        <p className="text-xs text-slate-500 mt-2">
          Future: signing credential binding, custom domains, app
          ownership transfer.
        </p>
      </div>
    </div>
  );
}

function DefaultChannelPicker({
  appId,
  app,
  isOrgAdmin,
}: {
  appId: string;
  app:
    | (App & {
        default_channel_id?: string | null;
        default_channel_slug?: string | null;
        default_channel_name?: string | null;
      })
    | undefined;
  isOrgAdmin: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const [selected, setSelected] = useState<string | null>(
    app?.default_channel_id ?? null,
  );
  useEffect(() => {
    setSelected(app?.default_channel_id ?? null);
  }, [app?.default_channel_id]);

  const save = useMutation({
    mutationFn: () => updateApp(appId, { default_channel_id: selected }),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: selected
          ? "Default release channel updated"
          : "Default channel cleared (will fall back to first channel)",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["app-detail", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Save failed",
        description: (e as Error).message,
      }),
  });

  const dirty = selected !== (app?.default_channel_id ?? null);

  return (
    <div className="border-t border-slate-100 pt-3">
      <h3 className="text-sm font-medium text-slate-700 mb-2">
        Default release channel
      </h3>
      <p className="text-xs text-slate-500 mb-2">
        Pre-fills the channel dropdown in the New Release dialog. Falls
        back to the first channel (by created_at) if unset.
      </p>
      <div className="flex items-center gap-2">
        <select
          className="input text-sm flex-1"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
          disabled={!isOrgAdmin || save.isPending}
        >
          <option value="">— none (use first channel) —</option>
          {channels.data?.channels.map((c: Channel) => (
            <option key={c.id} value={c.id}>
              {c.slug} ({c.name})
            </option>
          ))}
        </select>
        {isOrgAdmin && (
          <button
            className="btn-primary text-xs"
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {!isOrgAdmin && (
        <p className="text-xs text-yellow-700 mt-2">
          ⚠ Org owner / admin required to change settings.
        </p>
      )}
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
  const toggleToastRef = useRef<number | null>(null);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateVersion(appId, version.id, { enabled }),
    onMutate: (enabled) => {
      toggleToastRef.current = toast.show({
        kind: "loading",
        title: enabled ? "Enabling version..." : "Disabling version...",
        ttlMs: 0,
      });
    },
    onSuccess: (_data, enabled) => {
      const patch = {
        kind: "success",
        title: enabled ? "Version enabled" : "Version disabled",
      } as const;
      if (toggleToastRef.current !== null) toast.update(toggleToastRef.current, patch);
      else toast.show(patch);
      toggleToastRef.current = null;
      onToggled();
    },
    onError: (e) => {
      const patch = {
        kind: "error",
        title: "Toggle failed",
        description: (e as Error).message,
      } as const;
      if (toggleToastRef.current !== null) toast.update(toggleToastRef.current, patch);
      else toast.show(patch);
      toggleToastRef.current = null;
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
  const [slug, setSlug] = useState("main");
  const [name, setName] = useState("Main");
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
  app,
  channel,
  onClose,
  onSaved,
}: {
  appId: string;
  app:
    | (App & {
        default_channel_id?: string | null;
        default_channel_slug?: string | null;
        default_channel_name?: string | null;
      })
    | null
    | undefined;
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
  const [typedConfirm, setTypedConfirm] = useState("");

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
          </div>
        </form>
      </div>

      {/* Channel delete confirmation (typed-confirm + default-channel warning) */}
      <ConfirmActionDialog
        open={confirmDelete}
        title="Delete channel?"
        objectLabel={channel.slug}
        objectHint={`id: ${channel.id.slice(0, 8)}…`}
        objectSummary={
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <div className="text-slate-500">slug</div>
            <div>{channel.slug}</div>
            <div className="text-slate-500">name</div>
            <div>{channel.name}</div>
            <div className="text-slate-500">bundle_id</div>
            <div>{channel.bundle_id ?? "—"}</div>
          </div>
        }
        body={
          <>
            Deleting this channel removes it from this app.{" "}
            <strong>
              All releases pointing at this channel must be cancelled or moved
              first
            </strong>{" "}
            — otherwise the public API will start 404'ing your clients.
            {app?.default_channel_id === channel.id && (
              <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-900">
                ⚠ This is the app's <strong>default release channel</strong>.
                After deletion, the New Release wizard will fall back to the
                first channel by created_at.
              </div>
            )}
            <TypedConfirmField
              required={channel.slug}
              value={typedConfirm}
              onChange={setTypedConfirm}
            />
          </>
        }
        confirmLabel="Delete channel"
        cancelLabel="Keep channel"
        confirmKind="danger"
        confirmDisabled={typedConfirm !== channel.slug}
        pending={remove.isPending}
        onCancel={() => {
          setConfirmDelete(false);
          setTypedConfirm("");
        }}
        onConfirm={() => {
          remove.mutate();
          setConfirmDelete(false);
          setTypedConfirm("");
        }}
      />
    </div>
  );
}
