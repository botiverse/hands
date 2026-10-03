import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "raft-ui";
import { getReleaseHealth } from "../lib/api";

function Rate({ value }: { value: number | null }) {
  if (value == null) return <span className="text-foreground-hint">—</span>;
  const color = value >= 99 ? "text-success-strong" : value >= 95 ? "text-warning-strong" : "text-danger";
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
    <Card className="mb-4">
      <CardContent>
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-semibold">Release health</h3>
        <span className="text-xs text-foreground-muted">last {data.window_days} days</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mb-5">
        <div className="rounded-md border border-line-hairline p-3">
          <div className="text-xs text-foreground-muted mb-1">Crash-free sessions</div>
          <div className="text-2xl"><Rate value={data.totals.crash_free_sessions_pct} /></div>
          <div className="text-xs text-foreground-muted mt-1 tabular-nums">
            {data.totals.sessions - data.totals.crashed_sessions} of {data.totals.sessions} sessions
          </div>
        </div>
        <div className="rounded-md border border-line-hairline p-3">
          <div className="text-xs text-foreground-muted mb-1">Crash-free devices</div>
          <div className="text-2xl"><Rate value={data.totals.crash_free_devices_pct} /></div>
          <div className="text-xs text-foreground-muted mt-1 tabular-nums">
            {data.totals.devices - data.totals.crashed_devices} of {data.totals.devices} devices
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-foreground-muted">
            <tr className="border-b border-line-hairline">
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
                className="border-b border-line-hairline last:border-0"
              >
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className="font-medium text-foreground-strong">{version.version_name ?? "Unknown"}</span>
                  {version.version_code != null && (
                    <span className="ml-1 text-foreground-hint tabular-nums">{version.version_code}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-foreground-muted">{version.channel ?? "—"}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{version.sessions}</td>
                <td className="py-1.5 pr-3 text-right"><Rate value={version.crash_free_sessions_pct} /></td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{version.devices}</td>
                <td className="py-1.5 text-right"><Rate value={version.crash_free_devices_pct} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </CardContent></Card>
  );
}
