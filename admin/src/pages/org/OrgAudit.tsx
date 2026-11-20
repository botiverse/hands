/**
 * Organization › Audit: every app's audit log in one list, newest first,
 * drawn like an app's Audit page (outline action tags, the payload under a
 * pressed row).
 *
 * The server takes only a limit (?limit=, up to 500), so the toolbar narrows
 * the loaded entries: a search, the app, the area of the action and the
 * person, which live in the URL. When the latest 100 are all loaded, a link
 * loads up to 500.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ScrollText, Search, X } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  TextLink,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { listOrgAuditLogs } from "../../lib/api";
import { errorMessage } from "../../lib/errorMessage";
import { collidingPrincipalLabels, needsServerBadge } from "../../lib/principalIdentity";
import { useText } from "../../lib/locale";
import { AuditEntryRow, FilterSelect, actionArea, actorName, principal } from "../AuditLog";
import { OrgPage, type OrgFrame } from "./OrgPage";

const FIRST = 100;
const MOST = 500;

export function OrgAudit({ frame, canView }: { frame: OrgFrame; canView: boolean }) {
  const t = useText();
  const { orgId } = frame;
  const [params, setParams] = useSearchParams();
  const app = params.get("app") ?? "";
  const area = params.get("action") ?? "";
  const actorId = params.get("actor") ?? "";
  const [limit, setLimit] = useState(FIRST);
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  const logs = useQuery({
    queryKey: ["org-audit", orgId, limit],
    queryFn: () => listOrgAuditLogs(orgId, limit),
    enabled: canView,
    placeholderData: (previous) => previous,
  });
  const all = useMemo(() => logs.data?.logs ?? [], [logs.data]);

  const options = useMemo(() => {
    const apps = new Map<string, string>();
    const areas = new Set<string>();
    const actors = new Map<string, string>();
    for (const e of all) {
      apps.set(e.app_id, e.app_slug ?? e.app_id.slice(0, 8));
      areas.add(actionArea(e.action));
      if (e.actor_id) actors.set(e.actor_id, actorName(e));
    }
    return { apps, areas, actors };
  }, [all]);

  const needle = query.trim().toLowerCase();
  const rows = all.filter((e) =>
    (!app || e.app_id === app) &&
    (!area || actionArea(e.action) === area) &&
    (!actorId || e.actor_id === actorId) &&
    (!needle || [e.action, actorName(e), e.actor, e.payload, e.app_slug ?? ""].some((s) => s.toLowerCase().includes(needle))),
  );
  const collidingLabels = useMemo(() => collidingPrincipalLabels(rows.map(principal)), [rows]);
  const filtering = Boolean(app || area || actorId || needle);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const clearAll = () => {
    setQuery("");
    const next = new URLSearchParams(params);
    for (const key of ["app", "action", "actor"]) next.delete(key);
    setParams(next, { replace: true });
  };
  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const appItems: Record<string, string> = {
    "": t("All apps", "全部应用"),
    ...Object.fromEntries([...options.apps].sort((a, b) => a[1].localeCompare(b[1]))),
  };
  if (app && !appItems[app]) appItems[app] = app;
  const areaItems: Record<string, string> = {
    "": t("All actions", "全部操作"),
    ...Object.fromEntries([...options.areas].sort().map((a) => [a, a])),
  };
  if (area && !areaItems[area]) areaItems[area] = area;
  const actorItems: Record<string, string> = {
    "": t("Everyone", "所有人"),
    ...Object.fromEntries([...options.actors].sort((a, b) => a[1].localeCompare(b[1]))),
  };
  if (actorId && !actorItems[actorId]) actorItems[actorId] = actorId;

  if (!canView) {
    return (
      <OrgPage frame={frame}>
        <EmptyState className="py-16">
          <EmptyStateContent>
            <EmptyStateIcon><ScrollText aria-hidden="true" /></EmptyStateIcon>
            <EmptyStateTitle>{t("Members only", "仅限成员")}</EmptyStateTitle>
            <EmptyStateDescription>{t("Members, admins and owners of the organization can read its audit log.", "组织的成员、管理员和所有者可以查看审计日志。")}</EmptyStateDescription>
          </EmptyStateContent>
        </EmptyState>
      </OrgPage>
    );
  }

  return (
    <OrgPage
      frame={frame}
      count={logs.data ? rows.length : undefined}
      busy={logs.isLoading}
      toolbar={
        <>
          <InputGroup className="w-auto min-w-48 flex-1 max-sm:basis-full sm:max-w-72">
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput
              aria-label={t("Search the audit log", "搜索审计日志")}
              placeholder={t("Search", "搜索")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon align="inline-end">
              {query ? (
                <Button type="button" variant="ghost" size="icon-md" aria-label={t("Clear search", "清除搜索")} onClick={() => setQuery("")}>
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </InputGroupAddon>
          </InputGroup>
          <FilterSelect label={t("App", "应用")} items={appItems} value={app} onChange={(v) => setParam("app", v)} />
          <FilterSelect label={t("Action", "操作")} items={areaItems} value={area} onChange={(v) => setParam("action", v)} />
          <FilterSelect label={t("Person", "操作者")} items={actorItems} value={actorId} onChange={(v) => setParam("actor", v)} />
          {filtering && <TextLink onClick={clearAll}>{t("Clear all", "清除筛选")}</TextLink>}
        </>
      }
    >
      <div className="flex flex-col gap-0.5">
        {logs.isLoading && [0, 1, 2, 3].map((n) => <ListRowSkeleton key={n} cell />)}

        {logs.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load the audit log", "无法加载审计日志")}</BannerTitle>
              <BannerDescription>{errorMessage(logs.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void logs.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {logs.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><ScrollText aria-hidden="true" /></EmptyStateIcon>
              {filtering ? (
                <>
                  <EmptyStateTitle>{t("No entries match", "没有符合条件的记录")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Change the search or the filters, or clear them.", "修改搜索或筛选条件，或全部清除。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{t("Nothing recorded yet", "还没有记录")}</EmptyStateTitle>
                  <EmptyStateDescription>
                    {t("Every change to the organization's apps, from the console, the CLI or an agent, is recorded here.", "通过控制台、命令行或智能体对组织内应用做的每项修改都会记录在这里。")}
                  </EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}

        {rows.map((entry) => (
          <AuditEntryRow
            key={entry.id}
            entry={entry}
            showApp
            open={openIds.has(entry.id)}
            onToggle={() => toggle(entry.id)}
            serverSlug={needsServerBadge(principal(entry), collidingLabels) ? (entry.actor_server_slug ?? null) : null}
          />
        ))}

        {logs.data && all.length >= limit && (
          <p className="px-(--column-margin) pt-3 text-footnote text-foreground-muted">
            {t(`Showing the latest ${limit} entries.`, `仅显示最近 ${limit} 条记录。`)}
            {limit < MOST && (
              <>
                {" "}
                <TextLink onClick={() => setLimit(MOST)} disabled={logs.isFetching}>
                  {t(`Load the latest ${MOST}`, `加载最近 ${MOST} 条`)}
                </TextLink>
              </>
            )}
          </p>
        )}
      </div>
    </OrgPage>
  );
}
