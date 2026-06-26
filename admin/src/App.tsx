import { useState } from "react";
import { AppsList } from "./pages/AppsList";
import { AppDetail } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";

type View =
  | { kind: "apps" }
  | { kind: "app"; appId: string }
  | { kind: "audit"; appId: string }
  | { kind: "settings" };

export function App() {
  const [view, setView] = useState<View>({ kind: "apps" });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-6">
          <button
            onClick={() => setView({ kind: "apps" })}
            className="text-xl font-bold tracking-tight"
          >
            quiver
          </button>
          <nav className="flex gap-2">
            <button
              onClick={() => setView({ kind: "apps" })}
              className="px-3 py-1.5 rounded-md text-sm hover:bg-slate-100"
            >
              Apps
            </button>
            {view.kind === "app" && (
              <button
                onClick={() => setView({ kind: "audit", appId: view.appId })}
                className="px-3 py-1.5 rounded-md text-sm hover:bg-slate-100"
              >
                Audit
              </button>
            )}
            <button
              onClick={() => setView({ kind: "settings" })}
              className="px-3 py-1.5 rounded-md text-sm hover:bg-slate-100"
            >
              Settings
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
        {view.kind === "apps" && (
          <AppsList
            onSelectApp={(appId) => setView({ kind: "app", appId })}
          />
        )}
        {view.kind === "app" && (
          <AppDetail
            appId={view.appId}
            onShowAudit={() => setView({ kind: "audit", appId: view.appId })}
          />
        )}
        {view.kind === "audit" && <AuditLog appId={view.appId} />}
        {view.kind === "settings" && <Settings />}
      </main>

      <footer className="bg-white border-t border-slate-200 py-4 mt-8">
        <div className="max-w-5xl mx-auto px-4 text-xs text-slate-500">
          quiver admin · Cloudflare Native APK distribution
        </div>
      </footer>
    </div>
  );
}