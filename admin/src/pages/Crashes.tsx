/**
 * Crashes (/apps/:appId/crashes): crash groups by signature, filtered by
 * crash type (exceptions, native crashes, ANRs, system kills, WebView
 * renderer exits) and report origin, with crashes by version above them.
 * Opening a group shows it beside the list with its tickets.
 */
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bug } from "lucide-react";
import { Select, SelectContent, SelectIcon, SelectItem, SelectList, SelectTrigger, SelectValue } from "@botiverse/raft-ui";
import { getFeedbackStats, type CrashType } from "../lib/api";
import { CrashByVersion } from "../components/FeedbackTrends";
import { feedbackBuildScope } from "../components/FeedbackBuildScope";
import { CrashGroupsPage, crashTypeLabel } from "../components/CrashGroups";
import { useLocale, useText } from "../lib/locale";

const CRASH_TYPES: CrashType[] = ["exception", "native", "anr", "system_kill", "webview_renderer_gone"];

function parseCrashType(raw: string | null): CrashType | "" {
  return CRASH_TYPES.includes(raw as CrashType) ? (raw as CrashType) : "";
}

export function AppCrashes({ appId }: { appId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const [searchParams, setSearchParams] = useSearchParams();
  const crashType = parseCrashType(searchParams.get("crash_type"));
  const buildScope = feedbackBuildScope(searchParams.get("build_scope"));
  const stats = useQuery({
    queryKey: ["feedback-stats", appId, buildScope],
    queryFn: () => getFeedbackStats(appId, buildScope),
  });
  const setCrashType = (value: CrashType | "") => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("crash_type", value);
    else next.delete("crash_type");
    setSearchParams(next, { replace: true });
  };
  const typeItems: Record<string, string> = {
    "": t("All crash types", "所有崩溃类型"),
    ...Object.fromEntries(CRASH_TYPES.map((c) => [c, crashTypeLabel(c, locale)])),
  };
  const byVersion = stats.data?.crashes_by_version ?? [];

  return (
    <CrashGroupsPage
      appId={appId}
      kind="crash"
      icon={<Bug aria-hidden="true" />}
      title={t("Crashes", "崩溃")}
      crashType={crashType || undefined}
      toolbarStart={
        <Select items={typeItems} value={crashType} onValueChange={(v) => setCrashType(parseCrashType(v as string))}>
          <SelectTrigger aria-label={t("Crash type", "崩溃类型")} className="min-w-0 flex-1 sm:w-auto sm:min-w-44 sm:flex-none">
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              {Object.entries(typeItems).map(([value, label]) => (
                <SelectItem key={value || "all"} value={value}>{label}</SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>
      }
      above={
        byVersion.length > 0 && (
          <div className="max-w-md px-(--column-margin)">
            <CrashByVersion rows={byVersion} />
          </div>
        )
      }
      empty={
        crashType
          ? {
              title: t(`No ${crashTypeLabel(crashType, "en")} reports`, `没有${crashTypeLabel(crashType, "zh-CN")}报告`),
              description: t("Choose another crash type to see the rest.", "选择其他崩溃类型查看其余报告。"),
            }
          : {
              title: t("No crashes yet", "还没有崩溃"),
              description: t("Crashes the SDK reports are grouped here by signature.", "SDK 上报的崩溃会按特征分组显示在这里。"),
            }
      }
    />
  );
}
