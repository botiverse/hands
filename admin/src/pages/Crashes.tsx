/**
 * Dedicated crash triage page (/apps/:appId/crashes): crashes-by-version
 * overview plus signature groups. Clicking a group jumps to the Feedback
 * list pre-filtered to crash tickets.
 */
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getFeedbackStats, listCrashGroups, type CrashType } from "../lib/api";
import { CrashByVersion } from "../components/FeedbackTrends";

export const CRASH_TYPE_LABELS: Record<CrashType, string> = {
  exception: "Exception",
  native: "Native",
  anr: "ANR",
};

export const CRASH_TYPE_STYLES: Record<CrashType, string> = {
  exception: "bg-red-100 text-red-800",
  native: "bg-purple-100 text-purple-800",
  anr: "bg-orange-100 text-orange-800",
};

const TYPE_FILTERS: Array<{ value: CrashType | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "exception", label: "Exceptions" },
  { value: "native", label: "Native" },
  { value: "anr", label: "ANRs" },
];

function parseCrashType(raw: string | null): CrashType | "" {
  return raw === "anr" || raw === "native" || raw === "exception" ? raw : "";
}

export function AppCrashes({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const crashType = parseCrashType(searchParams.get("crash_type"));
  const setCrashType = (value: CrashType | "") => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("crash_type", value);
    else next.delete("crash_type");
    setSearchParams(next, { replace: true });
  };
  const groups = useQuery({
    queryKey: ["crash-groups", appId, crashType],
    queryFn: () => listCrashGroups(appId, undefined, crashType || undefined),
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
            Grouped by signature (exception class + top app frame; ANRs by the
            main thread's first app frame). Stacks are auto-deobfuscated when
            the build's mapping was uploaded.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Crash type">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value || "all"}
              type="button"
              aria-pressed={crashType === f.value}
              onClick={() => setCrashType(f.value)}
              className={`rounded-sm px-2 py-1 text-xs border ${
                crashType === f.value
                  ? "bg-slate-800 text-white border-slate-800"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {(stats.data?.crashes_by_version.length ?? 0) > 0 && (
        <div className="card p-4! max-w-md">
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
          <p className="text-sm text-slate-500">
            {crashType ? `No ${CRASH_TYPE_LABELS[crashType]} crashes reported.` : "No crashes reported yet. 🎉"}
          </p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">Type</th>
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
                  <td className="py-2 pr-3">
                    <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${CRASH_TYPE_STYLES[g.crash_type] ?? CRASH_TYPE_STYLES.exception}`}>
                      {CRASH_TYPE_LABELS[g.crash_type] ?? g.crash_type}
                    </span>
                  </td>
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
