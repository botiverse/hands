import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listApps, createApp, type App } from "../lib/api";

export function AppsList({ onSelectApp }: { onSelectApp: (id: string) => void }) {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: () => listApps(),
  });

  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Apps</h1>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          + New app
        </button>
      </div>

      {isLoading && <p className="text-slate-500">Loading...</p>}
      {error && (
        <p className="text-red-600">Failed: {(error as Error).message}</p>
      )}

      {data?.apps.length === 0 && (
        <p className="text-slate-500">
          No apps yet. Click "+ New app" to create your first one.
        </p>
      )}

      <div className="grid gap-3">
        {data?.apps.map((app) => (
          <AppRow key={app.id} app={app} onSelect={() => onSelectApp(app.id)} />
        ))}
      </div>

      {showCreate && (
        <CreateAppDialog
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
  return (
    <button
      onClick={onSelect}
      className="card hover:border-blue-300 text-left transition-colors w-full"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-medium">{app.name}</div>
          <div className="text-sm text-slate-500 font-mono">{app.slug}</div>
        </div>
        <span className="badge-blue">{app.platform}</span>
      </div>
    </button>
  );
}

function CreateAppDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("android");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => createApp({ slug, name, platform }),
    onSuccess: onCreated,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10">
      <div className="card max-w-md w-full">
        <h2 className="text-lg font-bold mb-4">Create app</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            create.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="label">Slug (e.g. myapp-android)</label>
            <input
              className="input"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="myapp-android"
              required
            />
          </div>
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              required
            />
          </div>
          <div>
            <label className="label">Platform</label>
            <select
              className="input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="android">Android</option>
              <option value="ios">iOS</option>
            </select>
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
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