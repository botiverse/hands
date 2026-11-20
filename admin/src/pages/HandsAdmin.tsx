/**
 * Hands admin (/admin): a read-only overview of the whole installation for
 * administrators of an approved Raft server. The totals first, then one
 * section per breakdown, each a group of rows with the count at the end.
 * A signed-out or unapproved visitor gets a page that says so.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Gauge, HardDrive, Layers, Rocket, ShieldAlert, Smartphone, Users } from "lucide-react";
import type { ReactNode } from "react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ListRow,
  ListRowBody,
  ListRowGroup,
  ListRowTitle,
  ListRowValue,
  Skeleton,
} from "@botiverse/raft-ui";
import { ApiError, getHandsAdminOverview } from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useLocale, useText } from "../lib/locale";
import { SectionNote, SettingsPage, SettingsSection } from "../components/SettingsPage";

export const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

const R2_NOTE = "R2 is measured from the bucket. Registered storage is deduplicated D1 metadata for build and feedback objects and can differ from R2.";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const TYPE_ZH: Record<string, string> = { human: "用户", agent: "智能体" };
const STATUS_ZH: Record<string, string> = { draft: "草稿", active: "有效", superseded: "已被替代", cancelled: "已取消" };

function CountRows({ rows, empty }: { rows: Array<[string, number]>; empty: string }) {
  const { locale } = useLocale();
  return (
    <ListRowGroup>
      {rows.length === 0 && (
        <ListRow variant="plain" interactive={false}>
          <ListRowBody><ListRowTitle className="font-normal text-foreground-muted">{empty}</ListRowTitle></ListRowBody>
        </ListRow>
      )}
      {rows.map(([label, count]) => (
        <ListRow key={label} variant="plain" interactive={false}>
          <ListRowBody><ListRowTitle>{label}</ListRowTitle></ListRowBody>
          <ListRowValue className="tabular-nums">{count.toLocaleString(locale)}</ListRowValue>
        </ListRow>
      ))}
    </ListRowGroup>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-layer-card px-4 py-3">
      <dt className="truncate text-footnote text-foreground-muted">{label}</dt>
      <dd className="truncate text-2xl leading-8 font-semibold tabular-nums text-foreground-strong">{value}</dd>
    </div>
  );
}

export function HandsAdmin() {
  const t = useText();
  const { locale } = useLocale();
  const overview = useQuery({ queryKey: ["hands-admin", "overview"], queryFn: getHandsAdminOverview, retry: false });
  const status = overview.error instanceof ApiError ? overview.error.status : null;
  const data = overview.data;
  const n = (v: number) => v.toLocaleString(locale);

  return (
    <SettingsPage
      icon={<Gauge aria-hidden="true" />}
      title={t("Observability", "监控概览")}
      meta={t("Hands admin", "Hands 管理")}
      busy={overview.isPending}
    >
      {overview.isPending && (
        <>
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-48 w-full" />
        </>
      )}

      {status === 401 && (
        <EmptyState className="py-16">
          <EmptyStateContent>
            <EmptyStateIcon><ShieldAlert aria-hidden="true" /></EmptyStateIcon>
            <EmptyStateTitle>{t("Sign in again", "请重新登录")}</EmptyStateTitle>
            <EmptyStateDescription>{t("Your session has expired or you're signed out. Sign in to continue.", "会话已过期或您已退出登录。请登录后继续。")}</EmptyStateDescription>
          </EmptyStateContent>
          <EmptyStateActions>
            <Button variant="primary" render={<a href="/api/auth/login?return=%2Fadmin" />} nativeButton={false}>
              {t("Continue with Raft", "使用 Raft 继续")}
            </Button>
          </EmptyStateActions>
        </EmptyState>
      )}

      {status === 403 && (
        <EmptyState className="py-16">
          <EmptyStateContent>
            <EmptyStateIcon><ShieldAlert aria-hidden="true" /></EmptyStateIcon>
            <EmptyStateTitle>{t("Administrator access required", "需要管理员权限")}</EmptyStateTitle>
            <EmptyStateDescription>{t("This page is limited to administrators of an approved Raft server.", "此页面仅供获准的 Raft 服务器管理员访问。")}</EmptyStateDescription>
          </EmptyStateContent>
        </EmptyState>
      )}

      {overview.error && status !== 401 && status !== 403 && (
        <Banner status="warning">
          <AlertTriangle aria-hidden="true" />
          <BannerTitle>{t("Could not load observability.", "无法加载监控信息。")}</BannerTitle>
          <BannerDescription>{errorMessage(overview.error)}</BannerDescription>
          <BannerAction>
            <Button variant="outline" onClick={() => void overview.refetch()}>{t("Retry", "重试")}</Button>
          </BannerAction>
        </Banner>
      )}

      {data && (
        <>
          <SettingsSection
            id="admin-totals"
            icon={<Layers />}
            title={t("Totals", "总量")}
            hint={t(`Measured ${new Date(data.measured_at).toLocaleString(locale)}`, `统计时间：${new Date(data.measured_at).toLocaleString(locale)}`)}
          >
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-hairline bg-line-hairline sm:grid-cols-3">
              <Stat label={t("Users", "用户")} value={n(data.summary.users)} />
              <Stat label={t("Organizations", "组织")} value={n(data.summary.organizations)} />
              <Stat label={t("Projects", "项目")} value={n(data.summary.apps)} />
              <Stat label={t("Active projects", "活跃项目")} value={n(data.summary.active_apps)} />
              <Stat label={t("Builds", "构建")} value={n(data.summary.builds)} />
              <Stat label={t("Releases", "版本")} value={n(data.summary.releases)} />
            </dl>
          </SettingsSection>

          <SettingsSection id="admin-storage" icon={<HardDrive />} title={t("Storage", "存储")}>
            <ListRowGroup>
              <ListRow variant="plain" interactive={false}>
                <ListRowBody><ListRowTitle>{t("R2 storage", "R2 存储")}</ListRowTitle></ListRowBody>
                <ListRowValue className="tabular-nums">{formatBytes(data.storage.r2.size_bytes)}</ListRowValue>
              </ListRow>
              <ListRow variant="plain" interactive={false}>
                <ListRowBody><ListRowTitle>{t("R2 objects", "R2 对象")}</ListRowTitle></ListRowBody>
                <ListRowValue className="tabular-nums">{n(data.storage.r2.object_count)}</ListRowValue>
              </ListRow>
              <ListRow variant="plain" interactive={false}>
                <ListRowBody><ListRowTitle>{t("Registered storage", "登记的存储")}</ListRowTitle></ListRowBody>
                <ListRowValue className="tabular-nums">
                  {formatBytes(data.storage.registered.size_bytes)} · {n(data.storage.registered.object_count)}
                </ListRowValue>
              </ListRow>
            </ListRowGroup>
            <SectionNote>
              {data.storage.note === R2_NOTE
                ? t(data.storage.note, "R2 数据直接从存储桶统计。登记的存储量来自构建和反馈对象的去重 D1 元数据，可能与 R2 不同。")
                : data.storage.note}
            </SectionNote>
          </SettingsSection>

          <SettingsSection id="admin-users" icon={<Users />} title={t("Users by type", "按类型统计用户")}>
            <CountRows
              empty={t("No users yet", "还没有用户")}
              rows={data.users_by_type.map((row) => [t(cap(row.type), TYPE_ZH[row.type] ?? row.type), row.count])}
            />
          </SettingsSection>
          <SettingsSection id="admin-platforms" icon={<Smartphone />} title={t("Projects by platform", "按平台统计项目")}>
            <CountRows empty={t("No projects yet", "还没有项目")} rows={data.apps_by_platform.map((row) => [row.type, row.count])} />
          </SettingsSection>
          <SettingsSection id="admin-builds" icon={<Boxes />} title={t("Builds by product type", "按产品类型统计构建")}>
            <CountRows empty={t("No builds yet", "还没有构建")} rows={data.builds_by_product_type.map((row) => [row.type, row.count])} />
          </SettingsSection>
          <SettingsSection id="admin-releases" icon={<Rocket />} title={t("Releases by status", "按状态统计版本")}>
            <CountRows
              empty={t("No releases yet", "还没有版本")}
              rows={data.releases_by_status.map((row) => [t(cap(row.status), STATUS_ZH[row.status] ?? row.status), row.count])}
            />
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
