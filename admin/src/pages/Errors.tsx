/**
 * Dedicated error triage page (/apps/:appId/errors): captured exceptions
 * (kind=error) grouped by signature. Clicking a group jumps to the Feedback
 * list pre-filtered to error tickets.
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listCrashGroups } from "../lib/api";

export function AppErrors({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const groups = useQuery({
    queryKey: ["error-groups", appId],
    queryFn: () => listCrashGroups(appId, "error"),
  });
  const rows = groups.data?.groups ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Errors</h2>
          <p className="text-sm text-slate-500">
            Errors reported by this app, grouped by signature so recurring
            problems are easier to identify. A signature combines the type of
            error with where it happened in your code.
          </p>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {groups.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {groups.error && (
          <p className="text-sm text-red-600">
            Failed to load error groups: {(groups.error as Error).message}
          </p>
        )}
        {!groups.isLoading && rows.length === 0 && (
          <p className="text-sm text-slate-500">No captured errors yet. 🎉</p>
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
                      `/apps/${appId}/feedback?kind=error&signature=${encodeURIComponent(g.signature)}`,
                    )
                  }
                >
                  <td className="py-2 pr-3 max-w-lg">
                    <code className="text-xs break-all">{g.signature}</code>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{g.count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.device_count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.open_count}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600 max-w-40 truncate">
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
