/**
 * Devices and versions on the app overview: active devices in the window,
 * the platforms they run, a row per version with its share (each opens that
 * version's feedback), and the per-version metrics table.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Smartphone } from "lucide-react";
import {
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  ListRowValue,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import { getDeviceAnalytics, getVersionMetrics } from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useText } from "../lib/locale";
import { OverviewEmpty, OverviewSection } from "./OverviewSection";

export function DeviceAnalytics({ appId }: { appId: string }) {
  const t = useText();
  const analytics = useQuery({
    queryKey: ["device-analytics", appId],
    queryFn: () => getDeviceAnalytics(appId, 30),
  });
  const versionMetrics = useQuery({
    queryKey: ["version-metrics", appId],
    queryFn: () => getVersionMetrics(appId, 30),
  });

  const data = analytics.data;
  const feedbackHref = (code: number) => `/apps/${appId}/feedback?version_code=${code}`;
  const metrics = versionMetrics.data?.versions ?? [];

  return (
    <OverviewSection
      id="overview-devices"
      icon={<Smartphone />}
      title={t("Devices and versions", "设备与版本")}
      hint={t("Last 30 days", "最近 30 天")}
    >
      {analytics.isLoading && <Skeleton className="h-28 w-full" />}
      {analytics.error && (
        <Text.Sans size="small" variant="warning">
          {t("Could not load devices:", "无法加载设备数据：")} {errorMessage(analytics.error)}
        </Text.Sans>
      )}
      {data && data.active_devices === 0 && (
        <OverviewEmpty
          icon={<Smartphone />}
          title={t("No devices yet", "还没有设备")}
          description={t(
            "Devices show up once your app checks Hands for updates.",
            "应用向 Hands 检查更新后，这里会显示设备。",
          )}
        />
      )}
      {data && data.active_devices > 0 && (
        <>
          <ListRowGroup>
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowTitle>{t("Active devices", "活跃设备")}</ListRowTitle>
                {data.by_platform.length > 1 && (
                  <ListRowDescription>
                    {data.by_platform.map((p) => `${p.platform} ${p.devices}`).join(" · ")}
                  </ListRowDescription>
                )}
              </ListRowBody>
              <ListRowValue className="font-mono text-foreground-strong tabular-nums">{data.active_devices}</ListRowValue>
            </ListRow>
            {data.by_version.map((v) => {
              const pct = Math.round((v.devices / data.active_devices) * 100);
              const content = (
                <>
                  <ListRowBody>
                    <ListRowTitle>
                      {v.version_name}
                      {v.version_code != null && (
                        <span className="ml-1.5 font-mono text-footnote font-normal text-foreground-hint">{v.version_code}</span>
                      )}
                    </ListRowTitle>
                    <span aria-hidden className="mt-1.5 block h-1.5 w-full max-w-80 rounded-full bg-fill-muted">
                      <span className="block h-full rounded-full bg-foreground-muted" style={{ width: `${Math.max(pct, 1)}%` }} />
                    </span>
                  </ListRowBody>
                  <ListRowValue className="font-mono tabular-nums">
                    {t(`${v.devices} · ${pct}%`, `${v.devices} 台 · ${pct}%`)}
                  </ListRowValue>
                </>
              );
              return v.version_code != null ? (
                <ListRow
                  key={`${v.version_name}-${v.version_code}`}
                  variant="plain"
                  render={<Link to={feedbackHref(v.version_code)} />}
                  aria-label={t(
                    `${v.version_name}: ${v.devices} devices, ${pct}%. Open feedback on version ${v.version_code}`,
                    `${v.version_name}：${v.devices} 台设备，${pct}%。查看版本 ${v.version_code} 的反馈`,
                  )}
                >
                  {content}
                  <ListRowChevron />
                </ListRow>
              ) : (
                <ListRow key={`${v.version_name}-none`} variant="plain" interactive={false}>
                  {content}
                </ListRow>
              );
            })}
          </ListRowGroup>

          {metrics.length > 0 && (
            <div className="flex flex-col gap-2 pt-2">
              <Text.Sans size="caption" variant="muted">
                {t(
                  `Version metrics, reported in the last ${versionMetrics.data?.window_days ?? 30} days`,
                  `版本指标，最近 ${versionMetrics.data?.window_days ?? 30} 天上报`,
                )}
              </Text.Sans>
              <TableScroll>
                <Table className="min-w-180">
                  <TableCaption className="sr-only">{t("Version metrics", "版本指标")}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Version", "版本")}</TableHead>
                      <TableHead>{t("Channel", "渠道")}</TableHead>
                      <TableHead align="right">{t("Active", "活跃")}</TableHead>
                      <TableHead align="right">{t("Seen", "上报设备")}</TableHead>
                      <TableHead align="right">{t("Current", "已是最新")}</TableHead>
                      <TableHead align="right">{t("Offered", "已提供更新")}</TableHead>
                      <TableHead align="right">{t("Feedback", "反馈")}</TableHead>
                      <TableHead align="right">{t("Downloads", "下载")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.slice(0, 8).map((v) => (
                      <TableRow key={`${v.release_id ?? "telemetry"}-${v.version_code ?? v.version_name}-${v.channel}`}>
                        <TableCell>
                          {v.version_code != null ? (
                            <TextLink variant="strong" render={<Link to={feedbackHref(v.version_code)} />} nativeButton={false} role="link">
                              {v.version_name}
                            </TextLink>
                          ) : (
                            <span className="font-medium text-foreground-strong">{v.version_name}</span>
                          )}
                          {v.version_code != null && (
                            <span className="ml-1.5 font-mono text-foreground-hint tabular-nums">{v.version_code}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-foreground-muted">{v.channel}</TableCell>
                        <TableCell align="right" className="font-mono tabular-nums">{v.active_devices}</TableCell>
                        <TableCell align="right" className="font-mono tabular-nums">{v.total_devices}</TableCell>
                        <TableCell align="right" className="font-mono tabular-nums">{v.update_current_count}</TableCell>
                        <TableCell align="right" className="font-mono tabular-nums">{v.update_offered_count}</TableCell>
                        <TableCell align="right" className="font-mono tabular-nums">
                          {v.feedback_count}
                          {v.crash_count > 0 && <span className="text-foreground-hint"> / {v.crash_count}</span>}
                        </TableCell>
                        <TableCell align="right" className="font-mono tabular-nums">{v.download_count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </div>
          )}
        </>
      )}
    </OverviewSection>
  );
}
