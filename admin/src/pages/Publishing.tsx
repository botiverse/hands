/**
 * Publishing management view (Zealot-style).
 *
 * Shows:
 *  - All versions for the current app, grouped by channel
 *  - Enable / Disable / Move-channel / Delete actions per version
 *  - New "Republish" action: re-uploads the same R2 key to a different channel
 *  - Filter by channel
 *  - Stats summary at top
 *
 * Per Zealot convention: each "scheme" (here: app+channel) has its own
 * version stream. The admin can promote a version between schemes
 * (channels) by clicking "Move".
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  listApps,
  listChannels,
  listPublicVersions,
  updateVersion,
  type App,
  type Channel,
  type Version,
} from "../lib/api";
import { useToast } from "../components/Toast";

export function Publishing({ appId }: { appId: string }) {
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

  const [filterChannel, setFilterChannel] = useState<string>("all");
  const [search, setSearch] = useState("");

  const filtered = (versions.data?.versions ?? [])
    .filter((v) => filterChannel === "all" || v.channel === filterChannel)
    .filter((v) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        v.version_name.toLowerCase().includes(s) ||
        v.package_name.toLowerCase().includes(s) ||
        v.signature_sha256.toLowerCase().includes(s) ||
        v.file_hash.toLowerCase().includes(s)
      );
    })
    .sort((a, b) => b.version_code - a.version_code);

  const stats = {
    total: versions.data?.versions.length ?? 0,
    enabled: (versions.data?.versions ?? []).filter((v) => v.enabled === 1)
      .length,
    byChannel: Object.fromEntries(
      Object.entries(
        (versions.data?.versions ?? []).reduce<Record<string, number>>(
          (acc, v) => {
            acc[v.channel] = (acc[v.channel] ?? 0) + 1;
            return acc;
          },
          {},
        ),
      ),
    ),
    totalSize: (versions.data?.versions ?? []).reduce(
      (sum, v) => sum + v.size_bytes,
      0,
    ),
  };

  // Loading-toast refs so we can update them in place after the mutation
  // settles. (TanStack v5 mutation context typing doesn't easily carry
  // extra fields, so refs are simpler than typing the generics.)
  const toggleToastRef = useRef<number | null>(null);
  const moveToastRef = useRef<number | null>(null);
  const forceToastRef = useRef<number | null>(null);

  const toggle = useMutation({
    mutationFn: ({ v, enabled }: { v: Version; enabled: boolean }) =>
      updateVersion(appId, v.id, { enabled }),
    onMutate: ({ enabled }) => {
      toggleToastRef.current = toast.show({
        kind: "loading",
        title: enabled ? "Enabling version…" : "Disabling version…",
      });
    },
    onSuccess: (_data, vars) => {
      const id = toggleToastRef.current;
      const patch = {
        kind: "success" as const,
        title: vars.enabled ? "Version enabled" : "Version disabled",
      };
      if (id != null) toast.update(id, patch);
      else toast.show(patch);
    },
    onError: (e) => {
      const id = toggleToastRef.current;
      const patch = {
        kind: "error" as const,
        title: "Toggle failed",
        description: e.message,
      };
      if (id != null) toast.update(id, patch);
      else toast.show(patch);
    },
    onSettled: () => {
      toggleToastRef.current = null;
      qc.invalidateQueries({ queryKey: ["versions", appId] });
    },
  });

  const moveChannel = useMutation({
    mutationFn: ({ v, channel }: { v: Version; channel: string }) =>
      updateVersion(appId, v.id, { channel }),
    onMutate: () => {
      moveToastRef.current = toast.show({ kind: "loading", title: "Moving version…" });
    },
    onSuccess: (_data, vars) => {
      const id = moveToastRef.current;
      const patch = {
        kind: "success" as const,
        title: `Moved v${vars.v.version_name} → ${vars.channel}`,
      };
      if (id != null) toast.update(id, patch);
      else toast.show(patch);
      qc.invalidateQueries({ queryKey: ["versions", appId] });
    },
    onError: (e) => {
      const id = moveToastRef.current;
      const patch = {
        kind: "error" as const,
        title: "Move failed",
        description: e.message,
      };
      if (id != null) toast.update(id, patch);
      else toast.show(patch);
    },
    onSettled: () => {
      moveToastRef.current = null;
    },
  });

  const toggleForceUpdate = useMutation({
    mutationFn: ({ v, next }: { v: Version; next: boolean }) =>
      updateVersion(appId, v.id, { should_force_update: next }),
    onMutate: () => {
      forceToastRef.current = toast.show({
        kind: "loading",
        title: "Updating force-update flag…",
      });
    },
    onSuccess: (_data, vars) => {
      const id = forceToastRef.current;
      const title = vars.next
        ? `v${vars.v.version_name} now requires install`
        : `v${vars.v.version_name} no longer forced`;
      const patch = { kind: "success" as const, title };
      if (id != null) toast.update(id, patch);
      else toast.show(patch);
      qc.invalidateQueries({ queryKey: ["versions", appId] });
    },
    onError: (e) => {
      const id = forceToastRef.current;
      const patch = {
        kind: "error" as const,
        title: "Force-update toggle failed",
        description: e.message,
      };
      if (id != null) toast.update(id, patch);
      else toast.show(patch);
    },
    onSettled: () => {
      forceToastRef.current = null;
    },
  });

  return (
    <div>
      <div className="mb-6">
        <div className="text-sm text-slate-500">Publishing</div>
        <h1 className="text-2xl font-bold">
          {app?.name ?? "..."}
          <span className="badge-blue align-middle ml-2">{app?.platform}</span>
        </h1>
        <div className="text-sm text-slate-500 font-mono">{app?.slug}</div>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Total versions" value={stats.total} />
        <Stat label="Enabled" value={`${stats.enabled} / ${stats.total}`} />
        <Stat
          label="Channels"
          value={Object.keys(stats.byChannel).length}
        />
        <Stat
          label="Total size"
          value={`${(stats.totalSize / 1024 / 1024).toFixed(1)} MB`}
        />
      </div>

      {/* Filters */}
      <div className="card !p-3 mb-4 flex flex-wrap gap-3 items-center">
        <input
          className="input flex-1 min-w-48"
          placeholder="Search by version, package, hash…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input w-40"
          value={filterChannel}
          onChange={(e) => setFilterChannel(e.target.value)}
        >
          <option value="all">All channels ({stats.total})</option>
          {channels.data?.channels.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.slug} ({stats.byChannel[c.slug] ?? 0})
            </option>
          ))}
        </select>
      </div>

      {/* Versions table (legacy read-only view) */}
      <div className="card !p-3 mb-3 bg-blue-50 border-blue-200 text-blue-900 text-xs">
        <strong>New flow:</strong> versions are created as releases with attached
        binaries (multi-arch Android / multi-OS Electron). Go to{" "}
        <a href={`/apps/${appId}/releases`} className="underline">
          Releases
        </a>{" "}
        to create one. This page is read-only legacy data.
      </div>
      <div className="space-y-2">
        {versions.isLoading && <p className="text-slate-500">Loading…</p>}
        {filtered.length === 0 && !versions.isLoading && (
          <p className="text-slate-500 text-sm">
            No legacy versions. Use the Releases tab to publish a new one.
          </p>
        )}
        {filtered.map((v) => (
          <PublishRow
            key={v.id}
            version={v}
            channels={channels.data?.channels ?? []}
            onToggle={(enabled) => toggle.mutate({ v, enabled })}
            onMove={(channel) => moveChannel.mutate({ v, channel })}
            onToggleForceUpdate={(next) =>
              toggleForceUpdate.mutate({ v, next })
            }
            busy={
              toggle.isPending ||
              moveChannel.isPending ||
              toggleForceUpdate.isPending
            }
          />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card !p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function PublishRow({
  version: v,
  channels,
  onToggle,
  onMove,
  onToggleForceUpdate,
  busy,
}: {
  version: Version;
  channels: Channel[];
  onToggle: (enabled: boolean) => void;
  onMove: (channel: string) => void;
  onToggleForceUpdate: (next: boolean) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const provenance = (() => {
    try {
      return JSON.parse(v.provenance_json || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const provenanceChips = Object.entries(provenance)
    .filter(([, val]) => val && val !== "")
    .map(([key, val]) => `${key}=${String(val)}`);
  return (
    <div className="card">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-medium">
              v{v.version_name} ({v.version_code})
            </span>
            <span className="badge-gray">{v.channel}</span>
            {v.enabled ? (
              <span className="badge-green">enabled</span>
            ) : (
              <span className="badge-gray">disabled</span>
            )}
            {v.should_force_update ? (
              <span
                className="badge-orange"
                title="Clients must install this version (no skip)"
              >
                ⚠ force update
              </span>
            ) : null}
            {v.availability_at &&
            v.availability_at > Date.now() ? (
              <span className="badge-blue">
                scheduled {new Date(v.availability_at).toISOString().slice(0, 16)}Z
              </span>
            ) : null}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-1 truncate">
            {v.package_name} · {(v.size_bytes / 1024 / 1024).toFixed(2)} MB ·{" "}
            {new Date(v.created_at).toISOString().split("T")[0]}
          </div>
          <div className="text-xs text-slate-400 font-mono mt-0.5 truncate">
            sha256: {v.signature_sha256.slice(0, 32)}…
          </div>
          {provenanceChips.length > 0 && (
            <div className="text-xs text-slate-500 font-mono mt-1 truncate">
              {provenanceChips.join(" · ")}
            </div>
          )}
          {v.changelog && (
            <button
              className="text-xs text-blue-600 hover:text-blue-800 mt-1"
              onClick={() => setShowChangelog(!showChangelog)}
            >
              {showChangelog ? "▾" : "▸"} Changelog
            </button>
          )}
        </div>

        {editing ? (
          <div className="flex gap-2 items-center">
            <select
              className="input text-sm w-32"
              defaultValue={v.channel}
              id={`move-target-${v.id}`}
              disabled={busy}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.slug}
                </option>
              ))}
            </select>
            <button
              className="btn-primary text-sm"
              disabled={busy}
              onClick={() => {
                const sel = document.getElementById(
                  `move-target-${v.id}`,
                ) as HTMLSelectElement;
                onMove(sel.value);
                setEditing(false);
              }}
            >
              Move
            </button>
            <button
              className="btn-secondary text-sm"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="btn-secondary text-sm"
              disabled={busy}
              title="Move this version to a different channel"
            >
              Move
            </button>
            <button
              onClick={() => onToggle(!v.enabled)}
              className={v.enabled ? "btn-secondary text-sm" : "btn-primary text-sm"}
              disabled={busy}
            >
              {v.enabled ? "Disable" : "Enable"}
            </button>
            <button
              onClick={() => onToggleForceUpdate(!v.should_force_update)}
              className={
                v.should_force_update
                  ? "btn-secondary text-sm"
                  : "btn-secondary text-sm"
              }
              disabled={busy}
              title="Toggle 'must install, no skip' for clients"
            >
              {v.should_force_update ? "Unforce" : "Force"}
            </button>
          </div>
        )}
      </div>
      {showChangelog && v.changelog && (
        <pre className="mt-3 pt-3 border-t border-slate-100 text-xs font-mono whitespace-pre-wrap text-slate-700 max-h-64 overflow-y-auto">
          {v.changelog}
        </pre>
      )}
    </div>
  );
}