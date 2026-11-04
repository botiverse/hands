import { errorMessage } from "../lib/errorMessage";
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
import { useLocale, useText } from "../lib/locale";

export function AppErrors({ appId }: { appId: string }) {
  const t = useText();
  const { locale } = useLocale();
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
          <h2 className="text-lg font-semibold">{t("Errors", "错误")}</h2>
          <p className="text-sm text-foreground-muted">
            {t("Errors reported by this app, grouped by signature so recurring problems are easier to identify. A signature combines the type of error with where it happened in your code.", "应用报告的错误按特征分组，便于识别反复出现的问题。特征结合了错误类型和代码中发生错误的位置。")}
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
        {groups.isLoading && <p className="text-sm text-foreground-muted">{t("Loading…", "加载中…")}</p>}
        {groups.error && (
          <p className="text-sm text-danger">
            {t("Failed to load error groups:", "加载错误分组失败：")} {errorMessage(groups.error)}
          </p>
        )}
        {!groups.isLoading && rows.length === 0 && (
          <EmptyState>
            <EmptyStateContent>
              <EmptyStateIcon>
                <AlertTriangle aria-hidden="true" />
              </EmptyStateIcon>
              <EmptyStateTitle>{t("No captured errors yet", "尚未捕获到错误")}</EmptyStateTitle>
            </EmptyStateContent>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-muted border-b border-line-muted">
                <th className="py-2 pr-3">{t("Signature", "特征")}</th>
                <th className="py-2 pr-3">{t("Count", "次数")}</th>
                <th className="py-2 pr-3">{t("Devices", "设备")}</th>
                <th className="py-2 pr-3">{t("Open", "未关闭")}</th>
                <th className="py-2 pr-3">{t("Versions", "版本")}</th>
                <th className="py-2 pr-3">{t("First seen", "首次出现")}</th>
                <th className="py-2 pr-3">{t("Last seen", "最近出现")}</th>
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
                    {new Date(g.first_seen).toLocaleDateString(locale)}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground">
                    {new Date(g.last_seen).toLocaleString(locale)}
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
