/**
 * Active-device analytics on the app overview: total active devices in the
 * window plus a version-distribution bar list and platform breakdown.
 * Inline SVG-free (CSS bars); colors use the validated categorical blue.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Tooltip, TooltipTrigger, TooltipContent, Progress, ProgressTrack, ProgressIndicator } from "raft-ui";
import { getDeviceAnalytics, getVersionMetrics } from "../lib/api";

const BAR_COLOR = "#2a78d6";

export function DeviceAnalytics({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const analytics = useQuery({
    queryKey: ["device-analytics", appId],
    queryFn: () => getDeviceAnalytics(appId, 30),
  });
  const versionMetrics = useQuery({
    queryKey: ["version-metrics", appId],
    queryFn: () => getVersionMetrics(appId, 30),
  });

  if (analytics.isLoading) return null;
  const data = analytics.data;
  if (!data || data.active_devices === 0) return null;

  const maxVersion = Math.max(1, ...data.by_version.map((v) => v.devices));

  return (
    <div className="card p-4!">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold">Active devices</h3>
        <span className="text-xs text-slate-500">reported in last 30 days</span>
      </div>

      <div className="flex items-end gap-2 mb-4">
        <span className="text-3xl font-semibold tabular-nums">{data.active_devices}</span>
        <span className="text-xs text-slate-500 mb-1">
          device{data.active_devices === 1 ? "" : "s"} reported
        </span>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_200px]">
        <div>
          <h4 className="text-xs font-medium text-slate-600 mb-2">Version distribution</h4>
          <div className="space-y-1.5">
            {data.by_version.map((v) => {
              const pct = Math.round((v.devices / data.active_devices) * 100);
              return (
                <Tooltip key={`${v.version_name}-${v.version_code}`}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 text-xs hover:opacity-80"
                        onClick={() =>
                          v.version_code != null &&
                          navigate(`/apps/${appId}/feedback?version_code=${v.version_code}`)
                        }
                      >
                        <span className="w-24 truncate text-left text-slate-600">
                          {v.version_name}
                        </span>
                        <Progress
                          value={(v.devices / maxVersion) * 100}
                          className="flex-1 gap-0"
                        >
                          <ProgressTrack className="h-3.5 bg-transparent rounded-none">
                            <ProgressIndicator
                              className="rounded-r-[4px]"
                              style={{ background: BAR_COLOR, minWidth: 2 }}
                            />
                          </ProgressTrack>
                        </Progress>
                        <span className="w-14 text-right tabular-nums text-slate-700">
                          {v.devices} · {pct}%
                        </span>
                      </button>
                    }
                  />
                  <TooltipContent>
                    {v.version_code ? `Feedback on version ${v.version_code}` : v.version_name}
                  </TooltipContent>
                </Tooltip>
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

      {(versionMetrics.data?.versions.length ?? 0) > 0 && (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="flex items-baseline justify-between mb-2">
            <h4 className="text-xs font-medium text-slate-600">Version metrics</h4>
            <span className="text-xs text-slate-500">reported in last {versionMetrics.data?.window_days ?? 30} days</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr className="border-b border-slate-100">
                  <th className="py-1.5 pr-3 text-left font-medium">Version</th>
                  <th className="py-1.5 pr-3 text-left font-medium">Channel</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Active</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Seen</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Current</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Offered</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Feedback</th>
                  <th className="py-1.5 text-right font-medium">Downloads</th>
                </tr>
              </thead>
              <tbody>
                {versionMetrics.data!.versions.slice(0, 8).map((v) => (
                  <tr
                    key={`${v.release_id ?? "telemetry"}-${v.version_code ?? v.version_name}-${v.channel}`}
                    className="border-b border-slate-50 last:border-0"
                  >
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <button
                        type="button"
                        className="font-medium text-slate-700 hover:text-blue-700"
                        onClick={() =>
                          v.version_code != null &&
                          navigate(`/apps/${appId}/feedback?version_code=${v.version_code}`)
                        }
                      >
                        {v.version_name}
                      </button>
                      {v.version_code != null && (
                        <span className="ml-1 text-slate-400 tabular-nums">{v.version_code}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">{v.channel}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v.active_devices}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v.total_devices}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v.update_current_count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v.update_offered_count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {v.feedback_count}
                      {v.crash_count > 0 && <span className="text-slate-400"> / {v.crash_count}</span>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{v.download_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
