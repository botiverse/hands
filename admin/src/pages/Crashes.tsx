import { errorMessage } from "../lib/errorMessage";
/**
 * Dedicated crash triage page (/apps/:appId/crashes): crashes-by-version
 * overview plus signature groups. Clicking a group jumps to the Feedback
 * list pre-filtered to crash tickets.
 */
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getFeedbackStats, getFeedbackBuildFilter, listCrashGroups, type CrashType } from "../lib/api";
import { Badge, EmptyState, EmptyStateContent, EmptyStateIcon, EmptyStateTitle, SegmentedControl, SegmentedControlItem, SegmentedControlLabel, type BadgeProps } from "raft-ui";
import { Bug } from "lucide-react";
import { CrashByVersion } from "../components/FeedbackTrends";
import { FeedbackBuildScopeSelector, feedbackBuildScope } from "../components/FeedbackBuildScope";
import { useLocale, useText } from "../lib/locale";

export const CRASH_TYPE_LABELS: Record<CrashType, string> = {
  exception: "Exception",
  native: "Native",
  anr: "ANR",
};

export const CRASH_TYPE_BADGE_VARIANTS: Record<CrashType, BadgeProps["variant"]> = {
  exception: "danger",
  native: "accent",
  anr: "warning",
};

const TYPE_FILTERS: Array<{ value: CrashType | ""; label: string; labelZh: string }> = [
  { value: "", label: "All", labelZh: "全部" },
  { value: "exception", label: "Exceptions", labelZh: "异常" },
  { value: "native", label: "Native", labelZh: "原生崩溃" },
  { value: "anr", label: "ANRs", labelZh: "无响应（ANR）" },
];

const CRASH_TYPE_LABELS_ZH: Record<CrashType, string> = { exception: "异常", native: "原生崩溃", anr: "无响应（ANR）" };

function parseCrashType(raw: string | null): CrashType | "" {
  return raw === "anr" || raw === "native" || raw === "exception" ? raw : "";
}

export function AppCrashes({ appId }: { appId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const crashType = parseCrashType(searchParams.get("crash_type"));
  const buildScope = feedbackBuildScope(searchParams.get("build_scope"));
  const originPolicy = useQuery({
    queryKey: ["feedback-build-filter", appId],
    queryFn: () => getFeedbackBuildFilter(appId),
  });
  const setCrashType = (value: CrashType | "") => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("crash_type", value);
    else next.delete("crash_type");
    setSearchParams(next, { replace: true });
  };
  const groups = useQuery({
    queryKey: ["crash-groups", appId, crashType, buildScope],
    queryFn: () => listCrashGroups(appId, undefined, crashType || undefined, buildScope),
  });
  const stats = useQuery({
    queryKey: ["feedback-stats", appId, buildScope],
    queryFn: () => getFeedbackStats(appId, buildScope),
  });
  const rows = groups.data?.groups ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Crashes", "崩溃")}</h2>
          <p className="text-sm text-foreground-muted">
            {t("Grouped by signature (exception class + top app frame; ANRs by the main thread's first app frame). Stacks are auto-deobfuscated when the build's mapping was uploaded.", "按特征分组（异常类和栈顶应用帧；无响应按主线程的首个应用帧）。上传构建的映射文件后，调用栈会自动反混淆。")}
          </p>
        </div>
        <SegmentedControl
          value={crashType}
          onValueChange={(value) => setCrashType(value as CrashType | "")}
          aria-label={t("Crash type", "崩溃类型")}
          className="w-fit"
        >
          {TYPE_FILTERS.map((f) => (
            <SegmentedControlItem key={f.value || "all"} value={f.value}>
              <SegmentedControlLabel>{t(f.label, f.labelZh)}</SegmentedControlLabel>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      {originPolicy.data?.default_enabled === 1 && (
        <FeedbackBuildScopeSelector value={buildScope} onChange={(value) => {
          const next = new URLSearchParams(searchParams);
          if (value === "standard") next.delete("build_scope"); else next.set("build_scope", value);
          setSearchParams(next, { replace: true });
        }} />
      )}
      {(stats.data?.crashes_by_version.length ?? 0) > 0 && (
        <div className="max-w-md">
          <CrashByVersion rows={stats.data!.crashes_by_version} />
        </div>
      )}

      <div className="overflow-x-auto">
        {groups.isLoading && <p className="text-sm text-foreground-muted">{t("Loading…", "加载中…")}</p>}
        {groups.error && (
          <p className="text-sm text-danger">
            {t("Failed to load crash groups:", "加载崩溃分组失败：")} {errorMessage(groups.error)}
          </p>
        )}
        {!groups.isLoading && rows.length === 0 && (
          <EmptyState>
            <EmptyStateContent>
              <EmptyStateIcon>
                <Bug aria-hidden="true" />
              </EmptyStateIcon>
              <EmptyStateTitle>
                {crashType ? t(`No ${CRASH_TYPE_LABELS[crashType]} crashes reported`, `尚无${CRASH_TYPE_LABELS_ZH[crashType]}报告`) : t("No crashes reported yet", "尚无崩溃报告")}
              </EmptyStateTitle>
            </EmptyStateContent>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-foreground-muted border-b border-line-muted">
                <th className="py-2 pr-3">{t("Type", "类型")}</th>
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
                      `/apps/${appId}/feedback?kind=crash&signature=${encodeURIComponent(g.signature)}&build_scope=${buildScope}`,
                    )
                  }
                >
                  <td className="py-2 pr-3">
                    <Badge variant={CRASH_TYPE_BADGE_VARIANTS[g.crash_type] ?? CRASH_TYPE_BADGE_VARIANTS.exception}>
                      {t(CRASH_TYPE_LABELS[g.crash_type] ?? g.crash_type, CRASH_TYPE_LABELS_ZH[g.crash_type] ?? g.crash_type)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 max-w-lg">
                    <code className="text-xs break-all">{g.signature}</code>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{g.count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.device_count}</td>
                  <td className="py-2 pr-3 tabular-nums">{g.open_count}</td>
                  <td className="py-2 pr-3 text-xs text-foreground-muted max-w-40 truncate">
                    {g.versions ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground-muted">
                    {new Date(g.first_seen).toLocaleDateString(locale)}
                  </td>
                  <td className="py-2 pr-3 text-xs text-foreground-muted">
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
