export function Settings() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Settings</h1>
      <div className="card space-y-3 text-sm">
        <p className="text-slate-600">
          Admin authentication is Login with Raft only. The Worker owns the
          OAuth callback and session cookie; Cloudflare Access can be disabled
          after the Raft client secret is configured.
        </p>
        <div>
          <div className="text-slate-500">Raft Callback URL</div>
          <div className="font-mono">https://quiver-worker.artin.workers.dev/login/raft/callback</div>
        </div>
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
          <div className="font-mono">apk-parser (Node 24 + aapt + apksigner)</div>
        </div>
      </div>
    </div>
  );
}
