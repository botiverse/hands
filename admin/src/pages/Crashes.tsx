/**
 * Dedicated crash triage page (/apps/:appId/crashes): crashes-by-version
 * overview plus signature groups. Clicking a group jumps to the Feedback
 * list pre-filtered to crash tickets.
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getFeedbackStats, listCrashGroups } from "../lib/api";
import { CrashByVersion } from "../components/FeedbackTrends";

export function AppCrashes({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const groups = useQuery({
    queryKey: ["crash-groups", appId],
    queryFn: () => listCrashGroups(appId),
  });
  const stats = useQuery({
    queryKey: ["feedback-stats", appId],
    queryFn: () => getFeedbackStats(appId),
  });
  const rows = groups.data?.groups ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Crashes</h2>
          <p className="text-sm text-slate-500">
            Grouped by signature (exception class + top app frame). Stacks are
            auto-deobfuscated when the build's mapping was uploaded.
          </p>
        </div>
      </div>

      {(stats.data?.crashes_by_version.length ?? 0) > 0 && (
        <div className="card !p-4 max-w-md">
          <CrashByVersion rows={stats.data!.crashes_by_version} />
        </div>
      )}

      <div className="card overflow-x-auto">
        {groups.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {groups.error && (
          <p className="text-sm text-red-600">
            Failed to load crash groups: {(groups.error as Error).message}
          </p>
        )}
        {!groups.isLoading && rows.length === 0 && (
          <p className="text-sm text-slate-500">No crashes reported yet. 🎉</p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">Signature</th>
                <th className="py-2 pr-3">Count</th>
                <th className="py-2 pr-3">Devices</th>
                <th className="py-2 pr-3">Open</th>
                <th className="py-2 pr-3">Versions</th>
                <th className="py-2 pr-3">First seen</th>
                <th className="py-2 pr-3">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr
                  key={g.signature}
                  className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50"
                  onClick={() =>
                    navigate(
                      `/apps/${appId}/feedback?kind=crash&signature=${encodeURIComponent(g.signature)}`,
                    )
                  }
                >
                  <td className="py-2 pr-3 max-w-lg">
                    <code className="text-xs break-all">{g.signature}</code>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{g.count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.device_count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.open_count}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600 max-w-[10rem] truncate">
                    {g.versions ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {new Date(g.first_seen).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">
                    {new Date(g.last_seen).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
