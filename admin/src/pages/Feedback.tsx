/**
 * Feedback — a page of a list: one row per ticket (feedback and bugs; crash
 * and error tickets live under Crashes and Errors, and show here when a
 * link scopes the list to a signature). The toolbar has the search, the
 * state and kind filters and the report origin; links from a ticket or a
 * crash group scope the list to a device, a version code or a signature.
 * Opening a row shows the ticket beside the list; the ticket also has its
 * own page, /apps/:appId/feedback/:ticketId, the link people share.
 */
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Link2, Maximize2, MessageSquare, Search, X } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
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
  ListRowTitle,
  ListRowTop,
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelScrollViewport,
  PanelTitle,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import {
  getDeviceDetail,
  getFeedbackBuildFilter,
  listFeedback,
  type FeedbackTicket,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useLocale, useText } from "../lib/locale";
import { useToast } from "../components/Toast";
import { FeedbackTrends } from "../components/FeedbackTrends";
import { FeedbackBuildScopeSelector, feedbackBuildScope } from "../components/FeedbackBuildScope";
import { DetailColumn, ListPage } from "../components/ListPage";
import {
  FeedbackTicketView,
  TICKET_KINDS,
  TICKET_STATUSES,
  TicketStatusBadge,
  buildOriginText,
  firstLine,
  kindLabel,
  statusLabel,
  ticketKindText,
  useFeedbackDetail,
} from "../components/FeedbackTicket";
import { timeAgo } from "./Operations";

/** Rows shown before "Show more". */
const PAGE_SIZE = 50;

type ScopeKey = "device_id" | "version_code" | "signature";

export function AppFeedback({ appId }: { appId: string }) {
  const tx = useText();
  const { locale } = useLocale();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";
  const kindFilter = searchParams.get("kind") ?? "";
  const deviceFilter = searchParams.get("device_id") ?? "";
  const versionFilter = searchParams.get("version_code") ?? "";
  const signatureFilter = searchParams.get("signature") ?? "";
  const buildScope = feedbackBuildScope(searchParams.get("build_scope"));
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);

  const originPolicy = useQuery({
    queryKey: ["feedback-build-filter", appId],
    queryFn: () => getFeedbackBuildFilter(appId),
  });
  const tickets = useQuery({
    queryKey: ["feedback", appId, statusFilter, kindFilter, deviceFilter, versionFilter, signatureFilter, buildScope],
    queryFn: () =>
      listFeedback(appId, {
        status: statusFilter || undefined,
        // Feedback = user feedback + bugs; crashes and errors have their own
        // pages. An explicit kind or signature filter overrides this.
        kind: kindFilter || (signatureFilter ? "crash,error" : "feedback,bug"),
        deviceId: deviceFilter || undefined,
        versionCode: versionFilter ? Number(versionFilter) : undefined,
        signature: signatureFilter || undefined,
        buildScope,
      }),
  });

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setShown(PAGE_SIZE);
  };
  const clearScope = (key: ScopeKey) => {
    const next = new URLSearchParams(searchParams);
    next.delete(key);
    setSearchParams(next);
  };
  const clearAll = () => {
    const next = new URLSearchParams(searchParams);
    for (const key of ["status", "kind", "device_id", "version_code", "signature"]) next.delete(key);
    setSearchParams(next);
    setQuery("");
  };

  const all = tickets.data?.tickets ?? [];
  const q = query.trim().toLocaleLowerCase();
  const rows = q ? all.filter((t) => ticketMatches(t, q)) : all;
  const open = all.find((t) => t.id === openId) ?? null;
  const scoped = Boolean(deviceFilter || versionFilter || signatureFilter);
  const filtering = Boolean(statusFilter || kindFilter || q || scoped);

  const statusItems: Record<string, string> = {
    "": tx("All states", "所有状态"),
    ...Object.fromEntries(TICKET_STATUSES.map((s) => [s, statusLabel(s, locale)])),
    closed: statusLabel("closed", locale),
  };
  const kindItems: Record<string, string> = {
    "": tx("Feedback and bugs", "反馈和缺陷"),
    ...Object.fromEntries(TICKET_KINDS.map((k) => [k, kindLabel(k, locale)])),
  };

  return (
    <ListPage
      icon={<MessageSquare aria-hidden="true" />}
      title={tx("Feedback", "反馈")}
      count={tickets.data ? rows.length : undefined}
      busy={tickets.isLoading}
      toolbar={
        <>
          <InputGroup className="w-auto min-w-48 flex-1 max-sm:basis-full sm:max-w-80">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={tx("Search feedback", "搜索反馈")}
              placeholder={tx("Search feedback", "搜索反馈")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE_SIZE);
              }}
            />
            <InputGroupAddon align="inline-end">
              {query ? (
                <Button type="button" variant="ghost" size="icon-md" aria-label={tx("Clear search", "清除搜索")} onClick={() => setQuery("")}>
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </InputGroupAddon>
          </InputGroup>
          <Select items={statusItems} value={statusFilter} onValueChange={(v) => setParam("status", (v as string) || null)}>
            <SelectTrigger aria-label={tx("State", "状态")} className="min-w-0 flex-1 sm:w-auto sm:min-w-36 sm:flex-none">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {Object.entries(statusItems).map(([value, label]) => (
                  <SelectItem key={value || "all"} value={value}>{label}</SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
          <Select items={kindItems} value={kindFilter} onValueChange={(v) => setParam("kind", (v as string) || null)}>
            <SelectTrigger aria-label={tx("Kind", "类型")} className="min-w-0 flex-1 sm:w-auto sm:min-w-36 sm:flex-none">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {Object.entries(kindItems).map(([value, label]) => (
                  <SelectItem key={value || "default"} value={value}>{label}</SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
          {originPolicy.data?.default_enabled === 1 && (
            <FeedbackBuildScopeSelector
              value={buildScope}
              onChange={(value) => setParam("build_scope", value === "standard" ? null : value)}
            />
          )}
          {filtering && <TextLink onClick={clearAll}>{tx("Clear all", "清除筛选")}</TextLink>}
        </>
      }
      detail={
        open && (
          <DetailColumn
            key={open.id}
            label={tx(`Ticket ${open.id.slice(0, 8)}`, `工单 ${open.id.slice(0, 8)}`)}
            title={firstLine(open.message) || tx("No message", "没有内容")}
            meta={<span className="font-mono">{open.id.slice(0, 8)}</span>}
            actions={
              <PanelAction
                aria-label={tx("Open as a page", "在单独页面打开")}
                render={<Link to={`/apps/${appId}/feedback/${open.id}`} />}
                nativeButton={false}
              >
                <Maximize2 aria-hidden="true" />
              </PanelAction>
            }
            onClose={() => setOpenId(null)}
          >
            <FeedbackTicketView appId={appId} ticketId={open.id} />
          </DetailColumn>
        )
      }
    >
      {scoped && (
        <div className="flex flex-col gap-3 px-(--column-margin)">
          {deviceFilter && <DeviceScope appId={appId} deviceId={deviceFilter} onClear={() => clearScope("device_id")} />}
          {versionFilter && (
            <ScopeLine label={tx("Version code", "版本号")} onClear={() => clearScope("version_code")}>
              <span className="font-mono">{versionFilter}</span>
            </ScopeLine>
          )}
          {signatureFilter && (
            <ScopeLine label={tx("Crash signature", "崩溃特征")} onClear={() => clearScope("signature")}>
              <span className="font-mono [overflow-wrap:anywhere]">{signatureFilter}</span>
              {all.length > 0 && (
                <span className="block text-foreground-muted">
                  {tx(
                    `${all.length} report${all.length === 1 ? "" : "s"} · ${distinct(all, "version_code")} version(s) · ${distinct(all, "device_id")} device(s)`,
                    `${all.length} 条记录 · ${distinct(all, "version_code")} 个版本 · ${distinct(all, "device_id")} 台设备`,
                  )}
                </span>
              )}
            </ScopeLine>
          )}
        </div>
      )}

      {!scoped && (
        <div className="px-(--column-margin)">
          <FeedbackTrends appId={appId} buildScope={buildScope} />
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {tickets.isLoading && [0, 1, 2, 3].map((n) => <ListRowSkeleton key={n} cell />)}

        {tickets.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{tx("Could not load feedback", "无法加载反馈")}</BannerTitle>
              <BannerDescription>{errorMessage(tickets.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void tickets.refetch()}>{tx("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {tickets.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><MessageSquare aria-hidden="true" /></EmptyStateIcon>
              {filtering ? (
                <>
                  <EmptyStateTitle>{tx("No tickets match", "没有符合条件的工单")}</EmptyStateTitle>
                  <EmptyStateDescription>{tx("Change the search or the filters, or clear them.", "修改搜索或筛选条件，或全部清除。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{tx("No feedback yet", "还没有反馈")}</EmptyStateTitle>
                  <EmptyStateDescription>
                    {tx("Feedback and bug reports sent from the app show up here. Crashes and errors have their own pages.", "应用内提交的反馈和缺陷报告会显示在这里。崩溃和错误在各自的页面中。")}
                  </EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}

        {rows.slice(0, shown).map((t) => (
          <TicketListRow key={t.id} ticket={t} selected={openId === t.id} onOpen={() => setOpenId(t.id)} />
        ))}

        {rows.length > shown && (
          <div className="flex items-center gap-3 px-(--column-margin) pt-3">
            <TextLink onClick={() => setShown((n) => n + PAGE_SIZE)}>{tx("Show more", "显示更多")}</TextLink>
            <Text.Sans size="small" variant="muted" className="font-mono">{`${shown} / ${rows.length}`}</Text.Sans>
          </div>
        )}
      </div>
    </ListPage>
  );
}

function ticketMatches(t: FeedbackTicket, q: string): boolean {
  return [t.id, t.message, t.assignee, t.contact, t.device_id, t.device_model, t.os_version, t.version_name, t.version_code?.toString()]
    .some((v) => v?.toLocaleLowerCase().includes(q));
}

function distinct(rows: FeedbackTicket[], key: "version_code" | "device_id"): number {
  return new Set(rows.map((r) => r[key]).filter(Boolean)).size;
}

function versionText(t: Pick<FeedbackTicket, "version_name" | "version_code">): string | null {
  if (!t.version_name && t.version_code == null) return null;
  return `${t.version_name ?? "?"}${t.version_code != null ? ` (${t.version_code})` : ""}`;
}

export function TicketListRow({
  ticket: t,
  selected,
  onOpen,
}: {
  ticket: FeedbackTicket;
  selected: boolean;
  onOpen: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const facts = [
    ticketKindText(t, locale),
    buildOriginText(t.build_origin, locale),
    versionText(t),
    [t.device_model, t.os_version].filter(Boolean).join(" · ") || null,
  ].filter(Boolean);
  const counts = [
    t.attachment_count ? tx(`${t.attachment_count} attachment${t.attachment_count === 1 ? "" : "s"}`, `${t.attachment_count} 个附件`) : null,
    t.comment_count ? tx(`${t.comment_count} comment${t.comment_count === 1 ? "" : "s"}`, `${t.comment_count} 条评论`) : null,
  ].filter(Boolean);
  return (
    <ListRow
      cell
      selected={selected}
      aria-current={selected || undefined}
      tone={t.status === "closed" ? "muted" : "default"}
      onClick={onOpen}
    >
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle>{firstLine(t.message) || tx("No message", "没有内容")}</ListRowTitle>
          <ListRowMeta>{timeAgo(t.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        <ListRowSubtitle>{facts.join(" · ")}</ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>
            {[t.assignee ?? tx("Unassigned", "未分配"), ...counts].join(" · ")}
          </ListRowDescription>
          <TicketStatusBadge status={t.status} />
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function ScopeLine({ label, onClear, children }: { label: string; onClear: () => void; children: ReactNode }) {
  const tx = useText();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line-hairline px-3 py-2 text-footnote">
      <div className="min-w-0 flex-1">
        <span className="block font-bold text-foreground-hint">{label}</span>
        {children}
      </div>
      <TextLink className="shrink-0" onClick={onClear}>{tx("Clear", "清除")}</TextLink>
    </div>
  );
}

function DeviceScope({ appId, deviceId, onClear }: { appId: string; deviceId: string; onClear: () => void }) {
  const tx = useText();
  const { locale } = useLocale();
  const detail = useQuery({
    queryKey: ["device-detail", appId, deviceId],
    queryFn: () => getDeviceDetail(appId, deviceId),
  });
  const d = detail.data?.device;
  return (
    <ScopeLine label={tx("Device", "设备")} onClear={onClear}>
      <span className="font-mono [overflow-wrap:anywhere]">{deviceId}</span>
      {d ? (
        <DescriptionList direction="horizontal" className="mt-2">
          <DescriptionItem>
            <DescriptionTerm>{tx("Latest version", "最新版本")}</DescriptionTerm>
            <DescriptionDetails>{versionText(d) ?? "—"}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Model", "型号")}</DescriptionTerm>
            <DescriptionDetails>{d.device_model ?? "—"}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Platform and OS", "平台和系统")}</DescriptionTerm>
            <DescriptionDetails>{[d.platform, d.os_version].filter(Boolean).join(" · ") || "—"}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Last seen", "最后活动时间")}</DescriptionTerm>
            <DescriptionDetails>{new Date(d.last_seen).toLocaleString(locale)}</DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      ) : detail.data ? (
        <span className="block text-foreground-muted">
          {tx("This device hasn't sent analytics yet. Its tickets are below.", "此设备还没有发送统计数据。它的工单在下方。")}
        </span>
      ) : null}
    </ScopeLine>
  );
}

/** The ticket's own page: the link people share. */
export function FeedbackTicketPage({ appId, ticketId }: { appId: string; ticketId: string }) {
  const tx = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const detail = useFeedbackDetail(appId, ticketId);
  const t = detail.data?.ticket;
  const title = tx(`Ticket ${ticketId.slice(0, 8)}`, `工单 ${ticketId.slice(0, 8)}`);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.show({ kind: "success", title: tx("Link copied", "链接已复制") });
    } catch (e) {
      toast.show({ kind: "error", title: tx("Could not copy the link", "无法复制链接"), description: errorMessage(e) });
    }
  };

  return (
    <Panel className="flex min-h-0 flex-1 flex-col" aria-label={title}>
      <PanelHeader>
        <PanelAction
          aria-label={tx("Back", "返回")}
          render={<Link to={`/apps/${appId}/${t?.kind === "crash" ? "crashes" : t?.kind === "error" ? "errors" : "feedback"}`} />}
          nativeButton={false}
          activateOnTouchEnd
        >
          <ArrowLeft aria-hidden="true" />
        </PanelAction>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h1 />}>{title}</PanelTitle>
          </PanelHeading>
          {t && <PanelMeta>{ticketKindText(t, locale)}</PanelMeta>}
        </PanelHeaderContent>
        <PanelActions>
          <PanelAction aria-label={tx("Copy link", "复制链接")} onClick={() => void copyLink()}>
            <Link2 aria-hidden="true" />
          </PanelAction>
        </PanelActions>
      </PanelHeader>
      <PanelScrollViewport
        className="min-h-0 flex-1"
        contentClassName="flex w-full max-w-3xl flex-col gap-6 px-(--column-margin) pt-4 pb-10"
      >
        <FeedbackTicketView appId={appId} ticketId={ticketId} />
      </PanelScrollViewport>
    </Panel>
  );
}
