export function Settings() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Settings</h1>
      <div className="card space-y-3 text-sm">
        <p className="text-slate-600">
          Phase 1 settings. Future: API token rotation, Cloudflare Access
          service token mapping, webhook URLs, retention policy.
        </p>
        <div>
          <div className="text-slate-500">Cloudflare Account</div>
          <div className="font-mono">cfb85626a067371c6e9a75191b5fb09d</div>
        </div>
        <div>
          <div className="text-slate-500">D1 Database</div>
          <div className="font-mono">quiver-db (fdc960cc-d1c5-41ae-96f3-c74df4b97d6b)</div>
        </div>
        <div>
          <div className="text-slate-500">R2 Bucket</div>
          <div className="font-mono">quiver-apks</div>
        </div>
        <div>
          <div className="text-slate-500">Container</div>
          <div className="font-mono">apk-parser (Node 20 + aapt + apksigner)</div>
        </div>
      </div>
    </div>
  );
}