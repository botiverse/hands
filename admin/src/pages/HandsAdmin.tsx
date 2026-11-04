import { useQuery } from "@tanstack/react-query";
import { ApiError, getHandsAdminOverview } from "../lib/api";
import { LanguagePicker, useText } from "../lib/locale";

const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

function Table({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  return (
    <section className="border-t border-line-hairline pt-5">
      <h2 className="mb-2 text-sm font-medium text-foreground-strong">{title}</h2>
      <div className="divide-y divide-line-hairline text-sm">
        {rows.map(([label, count]) => (
          <div className="flex justify-between py-2" key={label}><span>{label}</span><strong>{count}</strong></div>
        ))}
      </div>
    </section>
  );
}

export function HandsAdmin() {
  const t = useText();
  const overview = useQuery({ queryKey: ["hands-admin", "overview"], queryFn: getHandsAdminOverview, retry: false });
  if (overview.isPending) return <main className="p-8 text-sm text-foreground-muted"><LanguagePicker /><p>{t("Loading observability…", "正在加载监控信息…")}</p></main>;
  if (overview.error instanceof ApiError && overview.error.status === 401) {
    return <main className="p-8"><LanguagePicker /><h1 className="text-xl font-semibold">{t("Sign in again", "请重新登录")}</h1><p className="mt-2 text-sm text-foreground-muted">{t("Your session has expired or you're signed out. Sign in to continue.", "会话已过期或您已退出登录。请登录后继续。")}</p><a className="mt-4 inline-block text-info-strong" href="/api/auth/login?return=%2Fadmin">{t("Continue with Raft", "使用 Raft 继续")}</a></main>;
  }
  if (overview.error instanceof ApiError && overview.error.status === 403) {
    return <main className="p-8"><LanguagePicker /><h1 className="text-xl font-semibold">{t("Administrator access required", "需要管理员权限")}</h1><p className="mt-2 text-sm text-foreground-muted">{t("This page is limited to administrators of an approved Raft server.", "此页面仅供获准的 Raft 服务器管理员访问。")}</p></main>;
  }
  if (!overview.data) return <main className="p-8 text-sm text-danger"><LanguagePicker /><p>{t("Could not load observability.", "无法加载监控信息。")}</p></main>;
  const data = overview.data;
  const cards: Array<[string, string | number]> = [
    [t("Users", "用户"), data.summary.users], [t("Organizations", "组织"), data.summary.organizations], [t("Projects", "项目"), data.summary.apps],
    [t("Active projects", "活跃项目"), data.summary.active_apps], [t("Builds", "构建"), data.summary.builds], [t("Releases", "版本"), data.summary.releases],
    [t("R2 storage", "R2 存储"), formatBytes(data.storage.r2.size_bytes)], [t("R2 objects", "R2 对象"), data.storage.r2.object_count],
  ];
  return (
    <main className="mx-auto w-full max-w-7xl p-8">
      <LanguagePicker />
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-info-strong">{t("Hands admin", "Hands 管理")}</p>
      <h1 className="mt-1 text-3xl font-semibold">{t("Observability", "监控概览")}</h1>
      <p className="mt-2 text-sm text-foreground-muted">{t("Global, read-only product and storage inventory.", "全局产品与存储统计，仅供查看。")}</p>
      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value]) => <div key={label}><div className="text-sm text-foreground-muted">{label}</div><div className="mt-2 text-3xl font-semibold">{value}</div></div>)}</div>
      <p className="mt-5 text-xs text-foreground-muted">{data.storage.note === "R2 is measured from the bucket. Registered storage is deduplicated D1 metadata for build and feedback objects and can differ from R2." ? t(data.storage.note, "R2 数据直接从存储桶统计。登记的存储量来自构建和反馈对象的去重 D1 元数据，可能与 R2 不同。") : data.storage.note} {t(`Measured ${new Date(data.measured_at).toISOString()}.`, `统计时间：${new Date(data.measured_at).toISOString()}。`)}</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Table title={t("Users by type", "按类型统计用户")} rows={data.users_by_type.map((row) => [t(row.type, ({ human: "用户", agent: "智能体" } as Record<string, string>)[row.type] ?? row.type), row.count])} />
        <Table title={t("Projects by platform", "按平台统计项目")} rows={data.apps_by_platform.map((row) => [row.type, row.count])} />
        <Table title={t("Builds by product type", "按产品类型统计构建")} rows={data.builds_by_product_type.map((row) => [row.type, row.count])} />
        <Table title={t("Releases by status", "按状态统计版本")} rows={data.releases_by_status.map((row) => [t(row.status, ({ draft: "草稿", active: "有效", superseded: "已被替代", cancelled: "已取消" } as Record<string, string>)[row.status] ?? row.status), row.count])} />
      </div>
    </main>
  );
}
