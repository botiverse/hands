import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getAuthMe,
  listApps,
  listProductTypes,
  listChannels,
  type App,
} from "../lib/api";
import { AppCreationWizard } from "../components/AppCreationWizard";

export function AppsList({ onSelectApp, initialShowCreate }: { onSelectApp: (id: string) => void; initialShowCreate?: boolean }) {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: () => listApps(),
  });

  const [showCreate, setShowCreate] = useState(initialShowCreate ?? false);
  const [showArchived, setShowArchived] = useState(false);

  // Phase 1: filter archived client-side (server doesn't yet support query param).
  const visible = data?.apps.filter((a) => showArchived || !a.archived) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Apps</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded-sm"
            />
            Show archived ({data?.apps.filter((a) => a.archived).length ?? 0})
          </label>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            + New app
          </button>
        </div>
      </div>

      {isLoading && <p className="text-slate-500">Loading...</p>}
      {error && (
        <p className="text-red-600">Failed: {(error as Error).message}</p>
      )}

      {visible.length === 0 && !isLoading && (
        <p className="text-slate-500">
          {showArchived
            ? "No apps yet. Click \"+ New app\" to create your first one."
            : data?.apps.some((a) => a.archived)
              ? "All apps are archived. Toggle \"Show archived\" to view them."
              : "No apps yet. Click \"+ New app\" to create your first one."}
        </p>
      )}

      <div className="grid gap-3">
        {visible.map((app) => (
          <AppRow key={app.id} app={app} onSelect={() => onSelectApp(app.id)} />
        ))}
      </div>

      {showCreate && (
        <AppCreationWizard
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["apps"] });
          }}
        />
      )}
    </div>
  );
}

function AppRow({ app, onSelect }: { app: App; onSelect: () => void }) {
  const isArchived = !!app.archived;

  // Fetch counts for product_types / channels per app.
  // (Phase 2.3.A — lightweight stats inline on AppsList cards.)
  const productTypes = useQuery({
    queryKey: ["product-types", app.id],
    queryFn: () => listProductTypes(app.id),
  });
  const channels = useQuery({
    queryKey: ["channels", app.id],
    queryFn: () => listChannels(app.id),
  });
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const sameOrg = !app.org_id || app.org_id === me.data?.account.org_id;

  const ptCount = productTypes.data?.product_types.length ?? 0;
  const chCount = channels.data?.channels.length ?? 0;

  return (
    <button
      onClick={onSelect}
      className={`card text-left transition-colors w-full ${
        isArchived
          ? "opacity-60 hover:border-slate-400"
          : "hover:border-blue-300"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-lg font-medium">{app.name}</div>
            {isArchived && (
              <span className="badge-gray text-xs">📦 Archived</span>
            )}
            {!sameOrg && app.org_id && (
              <span
                className="badge-orange text-xs"
                title={`This app belongs to a different org (${app.org_id})`}
              >
                ⚠ other org
              </span>
            )}
          </div>
          <div className="text-sm text-slate-500 font-mono">{app.slug}</div>
          {app.description && (
            <div className="text-sm text-slate-600 mt-1 line-clamp-2">
              {app.description}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2 text-xs">
            <span
              className="badge-blue"
              title="Product types (what we ship)"
            >
              📦 {ptCount} product type{ptCount === 1 ? "" : "s"}
            </span>
            <span
              className="badge-gray"
              title="Distribution channels (main / preview / nightly)"
            >
              🚀 {chCount} channel{chCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <span className="badge-blue ml-3">{app.platform}</span>
      </div>
    </button>
  );
}
