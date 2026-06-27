import { useState } from "react";
import { AppsList } from "./pages/AppsList";
import { AppDetail } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";
import { Publishing } from "./pages/Publishing";

type View =
  | { kind: "apps" }
  | { kind: "app"; appId: string }
  | { kind: "audit"; appId: string }
  | { kind: "publish"; appId: string }
  | { kind: "settings" };

export function App() {
  const [view, setView] = useState<View>({ kind: "apps" });

  const navLink = (
    target: View["kind"],
    label: string,
    onClick: () => void,
  ) => (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm ${
        view.kind === target ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
      }`}
    >
      {label}
    </button>
  );

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
            {navLink("apps", "Apps", () => setView({ kind: "apps" }))}
            {view.kind === "app" && (
              <>
                {navLink("publish", "Publish", () =>
                  setView({ kind: "publish", appId: view.appId }),
                )}
                {navLink("audit", "Audit", () =>
                  setView({ kind: "audit", appId: view.appId }),
                )}
              </>
            )}
            {navLink("settings", "Settings", () => setView({ kind: "settings" }))}
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
            onShowPublish={() => setView({ kind: "publish", appId: view.appId })}
          />
        )}
        {view.kind === "publish" && <Publishing appId={view.appId} />}
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