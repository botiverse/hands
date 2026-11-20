import { useQuery } from "@tanstack/react-query";
import { HeartPulse } from "lucide-react";
import {
  ListRow,
  ListRowBody,
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
} from "@botiverse/raft-ui";
import { getReleaseHealth } from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useText } from "../lib/locale";
import { OverviewEmpty, OverviewSection } from "./OverviewSection";

/** A crash-free rate: lime at 99% and above, orange below (orange is "something
 *  went wrong" in Raft; red is kept for what cannot be undone). */
export function Rate({ value }: { value: number | null }) {
  if (value == null) return <span className="text-foreground-hint">—</span>;
  const color = value >= 99 ? "text-success-strong" : "text-warning-strong";
  return <span className={`font-mono font-semibold tabular-nums ${color}`}>{value.toFixed(2)}%</span>;
}

/** Crash-free sessions/devices for releases that have SDK session telemetry. */
export function ReleaseHealth({ appId }: { appId: string }) {
  const t = useText();
  const query = useQuery({
    queryKey: ["release-health", appId],
    queryFn: () => getReleaseHealth(appId, 30),
  });
  const data = query.data;
  const days = data?.window_days ?? 30;

  return (
    <OverviewSection
      id="overview-health"
      icon={<HeartPulse />}
      title={t("Release health", "版本健康状况")}
      hint={t(`Last ${days} days`, `最近 ${days} 天`)}
    >
      {query.isLoading && <Skeleton className="h-28 w-full" />}
      {query.error && (
        <Text.Sans size="small" variant="warning">
          {t("Could not load release health:", "无法加载版本健康状况：")} {errorMessage(query.error)}
        </Text.Sans>
      )}
      {data && data.totals.sessions === 0 && (
        <OverviewEmpty
          icon={<HeartPulse />}
          title={t("No session data yet", "还没有会话数据")}
          description={t(
            "Crash-free rates show up once the Hands SDK in your app reports sessions.",
            "应用中的 Hands SDK 上报会话后，这里会显示无崩溃率。",
          )}
        />
      )}
      {data && data.totals.sessions > 0 && (
        <>
          <ListRowGroup>
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowTitle>{t("Crash-free sessions", "无崩溃会话")}</ListRowTitle>
                <ListRowDescription>
                  {t(
                    `${data.totals.sessions - data.totals.crashed_sessions} of ${data.totals.sessions} sessions`,
                    `${data.totals.sessions} 次会话中 ${data.totals.sessions - data.totals.crashed_sessions} 次无崩溃`,
                  )}
                </ListRowDescription>
              </ListRowBody>
              <ListRowValue><Rate value={data.totals.crash_free_sessions_pct} /></ListRowValue>
            </ListRow>
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowTitle>{t("Crash-free devices", "无崩溃设备")}</ListRowTitle>
                <ListRowDescription>
                  {t(
                    `${data.totals.devices - data.totals.crashed_devices} of ${data.totals.devices} devices`,
                    `${data.totals.devices} 台设备中 ${data.totals.devices - data.totals.crashed_devices} 台无崩溃`,
                  )}
                </ListRowDescription>
              </ListRowBody>
              <ListRowValue><Rate value={data.totals.crash_free_devices_pct} /></ListRowValue>
            </ListRow>
          </ListRowGroup>

          {data.versions.length > 0 && (
            <TableScroll>
              <Table className="min-w-180">
                <TableCaption className="sr-only">{t("Release health by version", "各版本健康状况")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Version", "版本")}</TableHead>
                    <TableHead>{t("Channel", "渠道")}</TableHead>
                    <TableHead align="right">{t("Sessions", "会话")}</TableHead>
                    <TableHead align="right">{t("Crash-free sessions", "无崩溃会话")}</TableHead>
                    <TableHead align="right">{t("Devices", "设备")}</TableHead>
                    <TableHead align="right">{t("Crash-free devices", "无崩溃设备")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.versions.slice(0, 8).map((version) => (
                    <TableRow key={`${version.version_code ?? version.version_name}-${version.channel ?? ""}`}>
                      <TableCell>
                        <span className="font-medium text-foreground-strong">{version.version_name ?? t("Unknown", "未知")}</span>
                        {version.version_code != null && (
                          <span className="ml-1.5 font-mono text-foreground-hint tabular-nums">{version.version_code}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-foreground-muted">{version.channel ?? "—"}</TableCell>
                      <TableCell align="right" className="font-mono tabular-nums">{version.sessions}</TableCell>
                      <TableCell align="right"><Rate value={version.crash_free_sessions_pct} /></TableCell>
                      <TableCell align="right" className="font-mono tabular-nums">{version.devices}</TableCell>
                      <TableCell align="right"><Rate value={version.crash_free_devices_pct} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          )}
        </>
      )}
    </OverviewSection>
  );
}
