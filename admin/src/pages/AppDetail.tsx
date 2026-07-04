import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ConfirmActionDialog, TypedConfirmField } from "../components/ConfirmActionDialog";
import {
  archiveApp,
  getAuthMe,
  listApps,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  updateApp,
  type App,
  type Channel,
  uploadAppIcon,
  publicAppIconUrl,
  updateAppPublicHistory,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { Operations } from "./Operations";

export function AppDetail({ appId }: { appId: string }) {
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const appMissing = !apps.isLoading && !apps.error && !app;

  return (
    <div>
      {apps.error && (
        <AppErrorBanner
          title="Cannot load apps"
          error={apps.error}
        />
      )}
      {appMissing && (
        <AppErrorBanner
          title="App is not available"
          description="This app is not visible to the current account, or it no longer exists."
        />
      )}
      {channels.error && (
        <AppErrorBanner
          title="Cannot load app details"
          error={channels.error}
        />
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">App overview</h2>
            <p className="text-xs text-slate-500">
              Releases are managed from the{" "}
              <a href={`/apps/${appId}/releases`} className="underline">
                Releases
              </a>{" "}
              tab.
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
            <a
              href={`/apps/${appId}/channels`}
              className="btn-primary text-sm no-underline"
            >
              Create channel first
            </a>
          )}
        </div>
      </section>

      <section className="mt-8">
        <Operations appId={appId} />
      </section>
    </div>
  );
}

function AppErrorBanner({
  title,
  description,
  error,
}: {
  title: string;
  description?: string;
  error?: unknown;
}) {
  return (
    <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <div className="font-medium">{title}</div>
      <div className="text-xs mt-1">
        {description ?? (error instanceof Error ? error.message : String(error))}
      </div>
    </div>
  );
}

export function AppChannels({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  return (
    <div>

      <section>
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
    </div>
  );
}

function PublicHistoryToggle({ appId, app }: { appId: string; app: App }) {
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(app.public_history);
  const toggle = useMutation({
    mutationFn: () => updateAppPublicHistory(appId, !enabled),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !enabled ? "Public version history enabled" : "Public version history disabled",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Update failed",
        description: (e as Error).message,
      }),
  });
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">Public version history</div>
        <div className="text-xs text-slate-500">
          {enabled ? (
            <>
              Anyone can browse and download published versions at{" "}
              <a
                className="underline"
                href={`/apps/${app.slug}/history`}
                target="_blank"
                rel="noopener noreferrer"
              >
                /apps/{app.slug}/history
              </a>
              .
            </>
          ) : (
            "Expose a public page listing published versions with changelogs and downloads."
          )}
        </div>
      </div>
      <button
        className="btn-secondary !py-1 !px-2 !text-xs"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate()}
      >
        {toggle.isPending ? "…" : enabled ? "Disable" : "Enable"}
      </button>
    </div>
  );
}

function AppIconUploader({ appId, slug }: { appId: string; slug: string }) {
  const toast = useToast();
  const [bust, setBust] = useState(0);
  const upload = useMutation({
    mutationFn: (file: File) => uploadAppIcon(appId, file),
    onSuccess: () => {
      toast.show({ kind: "success", title: "App icon updated" });
      setBust(Date.now());
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Icon upload failed",
        description: (e as Error).message,
      }),
  });
  return (
    <div className="flex items-center gap-3">
      <img
        src={`${publicAppIconUrl(slug)}${bust ? `?v=${bust}` : ""}`}
        alt=""
        width={44}
        height={44}
        className="h-11 w-11 rounded-lg border border-slate-200 bg-slate-50 object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.visibility = "hidden";
        }}
        onLoad={(e) => {
          (e.target as HTMLImageElement).style.visibility = "visible";
        }}
      />
      <div>
        <div className="text-sm font-medium">App icon</div>
        <div className="text-xs text-slate-500">
          Shown on share/download pages. PNG/WebP/JPEG, max 1MB.
        </div>
      </div>
      <label className="btn-secondary !py-1 !px-2 !text-xs ml-auto cursor-pointer">
        {upload.isPending ? "Uploading…" : "Upload"}
        <input
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.currentTarget.value = "";
          }}
        />
      </label>
    </div>
  );
}

export function AppSettings({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
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
        title: archived ? "App archived" : "App restored",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
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
    <div>

      <div className="card !p-4 text-sm space-y-3">
        <h2 className="text-base font-semibold">Settings</h2>

        {/* App icon */}
        <AppIconUploader appId={appId} slug={app.slug} />

        {/* Public version history */}
        <PublicHistoryToggle appId={appId} app={app} />

        {/* Default release channel picker */}
        <DefaultChannelPicker appId={appId} app={app} isOrgAdmin={isOrgAdmin} />

        {/* Danger zone: archive / restore */}
        <div className="border-t border-slate-100 pt-3">
          <h3 className="text-sm font-medium text-slate-700 mb-2">
            Danger zone
          </h3>
          {!isOrgAdmin && (
            <p className="text-xs text-yellow-700 mb-2">
              ⚠ Org owner / admin required to archive apps.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 p-3 border border-slate-200 rounded-md">
            <div>
              <div className="font-medium">
                {app.archived ? "App is archived" : "App is active"}
              </div>
              <div className="text-xs text-slate-500">
                {app.archived
                  ? "Archived apps reject new uploads but remain restorable. " +
                    "Restore the app to resume normal operation."
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
                {app.archived ? "Restore app" : "Archive app"}
              </button>
            )}
          </div>

          <ConfirmActionDialog
            open={confirmArchive}
            title={app.archived ? "Restore this app?" : "Archive this app?"}
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
                  Restoring returns the app to <strong>active</strong> status.{" "}
                  New uploads and releases will be accepted again.
                  <br />
                  <span className="text-xs text-slate-500">
                    Existing builds, releases, and assets are kept as-is.
                  </span>
                </>
              ) : (
                <>
                  Archiving marks the app as <strong>archived</strong>.
                  The app remains viewable in lists and admin pages, but{" "}
                  <strong>new uploads are rejected</strong>.
                  <br />
                  <span className="text-xs text-slate-500">
                    This is reversible: builds,
                    releases, and assets are kept as-is. The underlying binary
                    data in R2 is not removed.
                  </span>
                </>
              )
            }
            confirmLabel={app.archived ? "Restore app" : "Archive app"}
            cancelLabel={app.archived ? "Keep archived" : "Keep app"}
            confirmKind={app.archived ? "primary" : "danger"}
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
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createChannel(appId, {
        slug,
        name,
        bundle_id: bundleId.trim() || undefined,
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
