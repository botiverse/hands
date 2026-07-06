/**
 * Active-device analytics on the app overview: total active devices in the
 * window plus a version-distribution bar list and platform breakdown.
 * Inline SVG-free (CSS bars); colors use the validated categorical blue.
 */
import { useQuery } from "@tanstack/react-query";
import { getDeviceAnalytics } from "../lib/api";

const BAR_COLOR = "#2a78d6";

export function DeviceAnalytics({ appId }: { appId: string }) {
  const analytics = useQuery({
    queryKey: ["device-analytics", appId],
    queryFn: () => getDeviceAnalytics(appId, 30),
  });

  if (analytics.isLoading) return null;
  const data = analytics.data;
  if (!data || data.active_devices === 0) return null;

  const maxVersion = Math.max(1, ...data.by_version.map((v) => v.devices));

  return (
    <div className="card !p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold">Active devices</h3>
        <span className="text-xs text-slate-500">last 30 days</span>
      </div>

      <div className="flex items-end gap-2 mb-4">
        <span className="text-3xl font-semibold tabular-nums">{data.active_devices}</span>
        <span className="text-xs text-slate-500 mb-1">
          device{data.active_devices === 1 ? "" : "s"} reported in
        </span>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_200px]">
        <div>
          <h4 className="text-xs font-medium text-slate-600 mb-2">Version distribution</h4>
          <div className="space-y-1.5">
            {data.by_version.map((v) => {
              const pct = Math.round((v.devices / data.active_devices) * 100);
              return (
                <div
                  key={`${v.version_name}-${v.version_code}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <span
                    className="w-24 truncate text-slate-600"
                    title={`${v.version_name} (${v.version_code ?? "?"})`}
                  >
                    {v.version_name}
                  </span>
                  <div className="flex-1 h-3.5">
                    <div
                      className="h-full rounded-r-[4px]"
                      style={{
                        width: `${(v.devices / maxVersion) * 100}%`,
                        background: BAR_COLOR,
                        minWidth: 2,
                      }}
                    />
                  </div>
                  <span className="w-14 text-right tabular-nums text-slate-700">
                    {v.devices} · {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {data.by_platform.length > 1 && (
          <div>
            <h4 className="text-xs font-medium text-slate-600 mb-2">Platform</h4>
            <div className="space-y-1">
              {data.by_platform.map((p) => (
                <div key={p.platform} className="flex justify-between text-xs text-slate-600">
                  <span>{p.platform}</span>
                  <span className="tabular-nums">{p.devices}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
