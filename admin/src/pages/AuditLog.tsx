/**
 * An app's audit log (/apps/:appId/audit): a page of a list, newest first.
 *
 * The toolbar narrows the entries: a search over the loaded entries, and the
 * area (action prefix), the person and the period, which the server applies
 * (?action_prefix=, ?actor_id=, ?since=) and which live in the URL. Each
 * entry is a row: the action as an outline mono tag, a short summary of its
 * payload, the actor and the time. Pressing the row shows the whole payload
 * under it.
 */
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ScrollText, Search, X } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  CodeBlock,
  CodeBlockBody,
  CodeBlockPre,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTop,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  TextLink,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { listAuditLogs, type AuditLogEntry } from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { collidingPrincipalLabels, needsServerBadge } from "../lib/principalIdentity";
import { useLocale, useText } from "../lib/locale";
import { ListPage } from "../components/ListPage";
import { timeAgo } from "./Operations";

const HOUR = 3_600_000;
const PERIODS: Record<string, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

/** The area of an action: the part before its first dot ("release" of "release.publish"). */
export function actionArea(action: string) {
  return action.split(/[.:]/)[0] ?? action;
}

export function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** Up to three scalar facts from a payload, as "key value", for the row. */
export function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    const text = String(value);
    parts.push(`${key} ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`);
    if (parts.length === 3) break;
  }
  return parts.join(" · ");
}

export function principal(entry: AuditLogEntry) {
  return {
    account_id: entry.actor_id ?? undefined,
    display_name: entry.actor_display_name ?? null,
    username: entry.actor_username ?? null,
    server_slug: entry.actor_server_slug ?? null,
  };
}

export function actorName(entry: AuditLogEntry) {
  return entry.actor_display_name || (entry.actor_username ? `@${entry.actor_username}` : null) || entry.actor;
}

export function AuditLog({ appId }: { appId: string }) {
  const t = useText();
  const [params, setParams] = useSearchParams();
  const area = params.get("action") ?? "";
  const actorId = params.get("actor") ?? "";
  const period = params.get("since") ?? "";
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  const logs = useQuery({
    queryKey: ["audit", appId, area, actorId, period],
    queryFn: () =>
      listAuditLogs(appId, {
        ...(area ? { actionPrefix: area } : {}),
        ...(actorId ? { actorId } : {}),
        ...(PERIODS[period] ? { since: Date.now() - PERIODS[period] } : {}),
      }),
  });
  // The server matches a prefix ("release" also matches "release_check.…"),
  // so keep only the entries of that exact area.
  const entries = useMemo(
    () => (logs.data?.logs ?? []).filter((e) => !area || actionArea(e.action) === area),
    [logs.data, area],
  );

  // The area and person options grow with what has been loaded, so picking
  // one filter doesn't take the other choices away.
  const seen = useRef({ areas: new Set<string>(), actors: new Map<string, string>() });
  for (const entry of entries) {
    seen.current.areas.add(actionArea(entry.action));
    if (entry.actor_id) seen.current.actors.set(entry.actor_id, actorName(entry));
  }
  if (area) seen.current.areas.add(area);

  // Computed once over the loaded entries, never per row (see principalIdentity).
  const collidingLabels = useMemo(() => collidingPrincipalLabels(entries.map(principal)), [entries]);

  const needle = query.trim().toLowerCase();
  const rows = needle
    ? entries.filter((e) =>
        [e.action, actorName(e), e.actor, e.payload].some((s) => s.toLowerCase().includes(needle)),
      )
    : entries;
  const filtering = Boolean(area || actorId || period || needle);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const clearAll = () => {
    setQuery("");
    const next = new URLSearchParams(params);
    for (const key of ["action", "actor", "since"]) next.delete(key);
    setParams(next, { replace: true });
  };
  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const areaItems: Record<string, string> = {
    "": t("All actions", "全部操作"),
    ...Object.fromEntries([...seen.current.areas].sort().map((a) => [a, a])),
  };
  const actorItems: Record<string, string> = {
    "": t("Everyone", "所有人"),
    ...Object.fromEntries([...seen.current.actors].sort((a, b) => a[1].localeCompare(b[1]))),
  };
  if (actorId && !actorItems[actorId]) actorItems[actorId] = actorId;
  const periodItems: Record<string, string> = {
    "": t("Any time", "全部时间"),
    "24h": t("Last 24 hours", "最近 24 小时"),
    "7d": t("Last 7 days", "最近 7 天"),
    "30d": t("Last 30 days", "最近 30 天"),
  };

  return (
    <ListPage
      icon={<ScrollText aria-hidden="true" />}
      title={t("Audit", "审计")}
      count={logs.data ? rows.length : undefined}
      busy={logs.isLoading}
      toolbar={
        <>
          <InputGroup className="w-auto min-w-48 flex-1 max-sm:basis-full sm:max-w-72">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
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
          <FilterSelect label={t("Action", "操作")} items={areaItems} value={area} onChange={(v) => setParam("action", v)} />
          <FilterSelect label={t("Person", "操作者")} items={actorItems} value={actorId} onChange={(v) => setParam("actor", v)} />
          <FilterSelect label={t("Period", "时间")} items={periodItems} value={period} onChange={(v) => setParam("since", v)} />
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
                    {t("Every change to this app, from the console, the CLI or an agent, is recorded here.", "通过控制台、命令行或智能体对此应用做的每项修改都会记录在这里。")}
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
            open={openIds.has(entry.id)}
            onToggle={() => toggle(entry.id)}
            serverSlug={needsServerBadge(principal(entry), collidingLabels) ? (entry.actor_server_slug ?? null) : null}
          />
        ))}

        {logs.data && entries.length >= 100 && (
          <p className="px-(--column-margin) pt-3 text-footnote text-foreground-muted">
            {t("Showing the latest 100 entries. Narrow the period or the filters to see older ones.", "仅显示最近 100 条记录。缩短时间范围或修改筛选条件可查看更早的记录。")}
          </p>
        )}
      </div>
    </ListPage>
  );
}

export function FilterSelect({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select items={items} value={value} onValueChange={(v) => onChange((v as string) || "")}>
      <SelectTrigger aria-label={label} className="min-w-0 flex-1 sm:w-auto sm:min-w-36 sm:flex-none">
        <SelectValue />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent>
        <SelectList>
          {Object.entries(items).map(([key, text]) => (
            <SelectItem key={key || "all"} value={key}>{text}</SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

export function AuditEntryRow({
  entry,
  open,
  onToggle,
  serverSlug,
  showApp = false,
}: {
  entry: AuditLogEntry;
  open: boolean;
  onToggle: () => void;
  serverSlug: string | null;
  /** On the organization's log: the entry's app beside its action. */
  showApp?: boolean;
}) {
  const t = useText();
  const { locale } = useLocale();
  const payload = useMemo(() => parsePayload(entry.payload), [entry.payload]);
  const summary = payloadSummary(payload);
  const name = actorName(entry);
  const panelId = `audit-payload-${entry.id}`;
  const when = new Date(entry.created_at).toLocaleString(locale);
  return (
    <div>
      <ListRow cell aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
        <ListRowBody>
          <ListRowTop>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Badge appearance="outline" className="min-w-0 truncate font-mono">{entry.action}</Badge>
              {showApp && (entry.app_slug || entry.app_id) && (
                <span className="min-w-0 shrink truncate font-mono text-footnote text-foreground-muted">{entry.app_slug ?? entry.app_id.slice(0, 8)}</span>
              )}
            </span>
            <ListRowMeta className="shrink-0" title={when}>{timeAgo(entry.created_at, locale)}</ListRowMeta>
          </ListRowTop>
          {summary && <ListRowSubtitle>{summary}</ListRowSubtitle>}
          <ListRowBottom>
            <ListRowDescription className="flex min-w-0 items-center gap-1.5">
              <Avatar size="xs" type={entry.actor_type === "agent" ? "agent" : "human"}>
                {entry.actor_avatar_url ? <AvatarImage src={entry.actor_avatar_url} alt="" /> : null}
                <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 truncate">
                {name}
                {entry.actor_username && entry.actor_display_name ? ` @${entry.actor_username}` : ""}
              </span>
            </ListRowDescription>
            {serverSlug && <Badge appearance="outline" className="shrink-0">{serverSlug}</Badge>}
            {entry.actor_type === "agent" && <Badge appearance="outline" className="shrink-0">{t("agent", "智能体")}</Badge>}
            {entry.actor_type === "system" && name !== "system" && <Badge appearance="outline" className="shrink-0">{t("system", "系统")}</Badge>}
          </ListRowBottom>
        </ListRowBody>
      </ListRow>
      {open && (
        <div id={panelId} className="px-(--column-margin) pt-1 pb-3">
          <CodeBlock>
            <CodeBlockBody>
              <CodeBlockPre aria-label={t(`Payload of ${entry.action}`, `${entry.action} 的内容`)} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {JSON.stringify(payload, null, 2)}
              </CodeBlockPre>
            </CodeBlockBody>
          </CodeBlock>
          <p className="mt-1.5 font-mono text-footnote text-foreground-hint">{when} · {entry.actor}</p>
        </div>
      )}
    </div>
  );
}
