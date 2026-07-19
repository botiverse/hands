import { useQuery } from "@tanstack/react-query";
import { getReleaseHealth } from "../lib/api";

function Rate({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-400">—</span>;
  const color = value >= 99 ? "text-emerald-700" : value >= 95 ? "text-amber-700" : "text-red-700";
  return <span className={`font-semibold tabular-nums ${color}`}>{value.toFixed(2)}%</span>;
}

/** Crash-free sessions/devices for releases that have SDK session telemetry. */
export function ReleaseHealth({ appId }: { appId: string }) {
  const query = useQuery({
    queryKey: ["release-health", appId],
    queryFn: () => getReleaseHealth(appId, 30),
  });
  const data = query.data;
  if (query.isLoading || !data || data.totals.sessions === 0) return null;

  return (
    <div className="card p-4! mb-4">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-semibold">Release health</h3>
        <span className="text-xs text-slate-500">last {data.window_days} days</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mb-5">
        <div className="rounded-md border border-slate-100 p-3">
          <div className="text-xs text-slate-500 mb-1">Crash-free sessions</div>
          <div className="text-2xl"><Rate value={data.totals.crash_free_sessions_pct} /></div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {data.totals.sessions - data.totals.crashed_sessions} of {data.totals.sessions} sessions
          </div>
        </div>
        <div className="rounded-md border border-slate-100 p-3">
          <div className="text-xs text-slate-500 mb-1">Crash-free devices</div>
          <div className="text-2xl"><Rate value={data.totals.crash_free_devices_pct} /></div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {data.totals.devices - data.totals.crashed_devices} of {data.totals.devices} devices
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500">
            <tr className="border-b border-slate-100">
              <th className="py-1.5 pr-3 text-left font-medium">Version</th>
              <th className="py-1.5 pr-3 text-left font-medium">Channel</th>
              <th className="py-1.5 pr-3 text-right font-medium">Sessions</th>
              <th className="py-1.5 pr-3 text-right font-medium">Crash-free sessions</th>
              <th className="py-1.5 pr-3 text-right font-medium">Devices</th>
              <th className="py-1.5 text-right font-medium">Crash-free devices</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.slice(0, 8).map((version) => (
              <tr
                key={`${version.version_code ?? version.version_name}-${version.channel ?? ""}`}
                className="border-b border-slate-50 last:border-0"
              >
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className="font-medium text-slate-700">{version.version_name ?? "Unknown"}</span>
                  {version.version_code != null && (
                    <span className="ml-1 text-slate-400 tabular-nums">{version.version_code}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-slate-600">{version.channel ?? "—"}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{version.sessions}</td>
                <td className="py-1.5 pr-3 text-right"><Rate value={version.crash_free_sessions_pct} /></td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{version.devices}</td>
                <td className="py-1.5 text-right"><Rate value={version.crash_free_devices_pct} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
