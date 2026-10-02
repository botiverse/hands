import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useEffect, type ReactNode } from "react";
import { listApps } from "../lib/api";
import { appRouteMessage } from "../lib/appRouteMessages";

export function AppRouteBoundary({ appId, children }: { appId: string; children: ReactNode }) {
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId);
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => listApps(), enabled: valid });
  const available = valid && !apps.isError && apps.data?.apps.some((app) => app.id === appId);
  useEffect(() => {
    if (available) {
      try { window.localStorage.setItem("quiver:last-app-id", appId); } catch { /* storage disabled */ }
    }
  }, [available, appId]);
  if (valid && apps.isPending) return <div role="status" className="card p-6">{appRouteMessage("loading")}</div>;
  if (available) return children;
  return <section role="alert" className="card p-6 space-y-3">
    <h1 className="text-lg font-semibold">{appRouteMessage(valid ? "unavailable" : "invalid")}</h1>
    <p className="text-sm text-slate-600">{appRouteMessage(valid ? (apps.isError ? "loadFailed" : "accessHint") : "uuidHint")}</p>
    <Link className="text-blue-600 underline" to="/apps">{appRouteMessage("back")}</Link>
  </section>;
}
