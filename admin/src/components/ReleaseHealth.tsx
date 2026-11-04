import { useQuery } from "@tanstack/react-query";
import { getReleaseHealth } from "../lib/api";
import { useText } from "../lib/locale";

function Rate({ value }: { value: number | null }) {
  if (value == null) return <span className="text-foreground-hint">—</span>;
  const color = value >= 99 ? "text-success-strong" : value >= 95 ? "text-warning-strong" : "text-danger";
  return <span className={`font-semibold tabular-nums ${color}`}>{value.toFixed(2)}%</span>;
}

/** Crash-free sessions/devices for releases that have SDK session telemetry. */
export function ReleaseHealth({ appId }: { appId: string }) {
  const t = useText();
  const query = useQuery({
    queryKey: ["release-health", appId],
    queryFn: () => getReleaseHealth(appId, 30),
  });
  const data = query.data;
  if (query.isLoading || !data || data.totals.sessions === 0) return null;

  return (
    <section className="mb-4 border-t border-line-hairline pt-5">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-medium text-foreground-strong">{t("Release health", "版本健康状况")}</h3>
        <span className="text-xs text-foreground-muted">{t(`last ${data.window_days} days`, `最近 ${data.window_days} 天`)}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mb-5">
        <div className="rounded-md bg-fill-muted p-3">
          <div className="text-xs text-foreground-muted mb-1">{t("Crash-free sessions", "无崩溃会话")}</div>
          <div className="text-2xl"><Rate value={data.totals.crash_free_sessions_pct} /></div>
          <div className="text-xs text-foreground-muted mt-1 tabular-nums">
            {t(`${data.totals.sessions - data.totals.crashed_sessions} of ${data.totals.sessions} sessions`, `${data.totals.sessions} 次会话中 ${data.totals.sessions - data.totals.crashed_sessions} 次无崩溃`)}
          </div>
        </div>
        <div className="rounded-md bg-fill-muted p-3">
          <div className="text-xs text-foreground-muted mb-1">{t("Crash-free devices", "无崩溃设备")}</div>
          <div className="text-2xl"><Rate value={data.totals.crash_free_devices_pct} /></div>
          <div className="text-xs text-foreground-muted mt-1 tabular-nums">
            {t(`${data.totals.devices - data.totals.crashed_devices} of ${data.totals.devices} devices`, `${data.totals.devices} 台设备中 ${data.totals.devices - data.totals.crashed_devices} 台无崩溃`)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-foreground-muted">
            <tr className="border-b border-line-hairline">
              <th className="py-1.5 pr-3 text-left font-medium">{t("Version", "版本")}</th>
              <th className="py-1.5 pr-3 text-left font-medium">{t("Channel", "渠道")}</th>
              <th className="py-1.5 pr-3 text-right font-medium">{t("Sessions", "会话")}</th>
              <th className="py-1.5 pr-3 text-right font-medium">{t("Crash-free sessions", "无崩溃会话")}</th>
              <th className="py-1.5 pr-3 text-right font-medium">{t("Devices", "设备")}</th>
              <th className="py-1.5 text-right font-medium">{t("Crash-free devices", "无崩溃设备")}</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.slice(0, 8).map((version) => (
              <tr
                key={`${version.version_code ?? version.version_name}-${version.channel ?? ""}`}
                className="border-b border-line-hairline last:border-0"
              >
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className="font-medium text-foreground-strong">{version.version_name ?? t("Unknown", "未知")}</span>
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
    </section>
  );
}
