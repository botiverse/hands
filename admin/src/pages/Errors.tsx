/**
 * Dedicated error triage page (/apps/:appId/errors): captured exceptions
 * (kind=error) grouped by signature. Clicking a group jumps to the Feedback
 * list pre-filtered to error tickets.
 */
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getFeedbackBuildFilter, listCrashGroups } from "../lib/api";
import { EmptyState, EmptyStateContent, EmptyStateIcon, EmptyStateTitle } from "raft-ui";
import { AlertTriangle } from "lucide-react";
import { FeedbackBuildScopeSelector, feedbackBuildScope } from "../components/FeedbackBuildScope";

export function AppErrors({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const buildScope = feedbackBuildScope(searchParams.get("build_scope"));
  const originPolicy = useQuery({ queryKey: ["feedback-build-filter", appId], queryFn: () => getFeedbackBuildFilter(appId) });
  const groups = useQuery({
    queryKey: ["error-groups", appId, buildScope],
    queryFn: () => listCrashGroups(appId, "error", undefined, buildScope),
  });
  const rows = groups.data?.groups ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Errors</h2>
          <p className="text-sm text-foreground-muted">
            Errors reported by this app, grouped by signature so recurring
            problems are easier to identify. A signature combines the type of
            error with where it happened in your code.
          </p>
        </div>
      </div>

      {originPolicy.data?.default_enabled === 1 && (
        <FeedbackBuildScopeSelector value={buildScope} onChange={(value) => {
          const next = new URLSearchParams(searchParams);
          if (value === "standard") next.delete("build_scope"); else next.set("build_scope", value);
          setSearchParams(next, { replace: true });
        }} />
      )}
      <div className="overflow-x-auto">
        {groups.isLoading && <p className="text-sm text-foreground-muted">Loading…</p>}
        {groups.error && (
          <p className="text-sm text-danger">
            Failed to load error groups: {(groups.error as Error).message}
          </p>
        )}
        {!groups.isLoading && rows.length === 0 && (
          <EmptyState>
            <EmptyStateContent>
              <EmptyStateIcon>
                <AlertTriangle aria-hidden="true" />
              </EmptyStateIcon>
              <EmptyStateTitle>No captured errors yet</EmptyStateTitle>
            </EmptyStateContent>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-muted border-b border-line-muted">
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
                  className="border-b border-line-hairline last:border-0 cursor-pointer hover:bg-fill-muted"
                  onClick={() =>
                    navigate(
                      `/apps/${appId}/feedback?kind=error&signature=${encodeURIComponent(g.signature)}&build_scope=${buildScope}`,
                    )
                  }
                >
                  <td className="py-2 pr-3 max-w-lg">
                    <code className="text-xs break-all">{g.signature}</code>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{g.count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.device_count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.open_count}</td>
                  <td className="py-2 pr-3 text-xs text-foreground max-w-40 truncate">
                    {g.versions ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground">
                    {new Date(g.first_seen).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground">
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
