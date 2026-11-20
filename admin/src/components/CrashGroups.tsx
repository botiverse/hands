/**
 * Crash and error groups — the list on the Crashes and Errors pages: one row
 * per signature with its type, how often and on how many devices it
 * happened, the versions and when it was last seen. Opening a row shows the
 * group beside the list: the full signature, its numbers, the background
 * system kills by version and device, and its tickets.
 */
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  CodeBlock,
  CodeBlockBody,
  CodeBlockPre,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowGroup,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  ListRowValue,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import {
  getFeedbackBuildFilter,
  listCrashGroups,
  listFeedback,
  type CrashGroup,
  type CrashType,
  type FeedbackBuildScope,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useLocale, useText, type Locale } from "../lib/locale";
import { timeAgo } from "../pages/Operations";
import { TicketListRow } from "../pages/Feedback";
import { DetailColumn, DetailSection, ListPage } from "./ListPage";
import { FeedbackBuildScopeSelector, feedbackBuildScope } from "./FeedbackBuildScope";
import { CRASH_TYPE_LABELS, CRASH_TYPE_LABELS_ZH } from "./FeedbackTicket";

export const BACKGROUND_SYSTEM_KILL_SIGNATURE = "SystemKill@background";

/** Tickets of a group shown in its column before "Show all". */
const GROUP_TICKETS = 20;

export function crashTypeLabel(type: CrashType, locale: Locale): string {
  return (locale === "zh-CN" ? CRASH_TYPE_LABELS_ZH : CRASH_TYPE_LABELS)[type] ?? type;
}

function groupTitle(g: CrashGroup, locale: Locale): string {
  if (g.signature === BACKGROUND_SYSTEM_KILL_SIGNATURE) {
    return locale === "zh-CN" ? "后台被系统结束" : "Killed by the system in the background";
  }
  return g.signature;
}

function feedbackLink(appId: string, kind: "crash" | "error", signature: string, buildScope: FeedbackBuildScope, extra: Record<string, string> = {}) {
  const qs = new URLSearchParams({ kind, signature, build_scope: buildScope, ...extra });
  return `/apps/${appId}/feedback?${qs.toString()}`;
}

export function CrashGroupsPage({
  appId,
  kind,
  icon,
  title,
  crashType,
  toolbarStart,
  above,
  empty,
}: {
  appId: string;
  kind: "crash" | "error";
  icon: ReactNode;
  title: string;
  /** The crash type the list is filtered to (Crashes only). */
  crashType?: CrashType | undefined;
  /** Filters before the report origin. */
  toolbarStart?: ReactNode;
  /** Shown above the rows, such as crashes by version. */
  above?: ReactNode;
  empty: { title: string; description: string; filtered?: boolean };
}) {
  const tx = useText();
  const [searchParams, setSearchParams] = useSearchParams();
  const buildScope = feedbackBuildScope(searchParams.get("build_scope"));
  const [openSignature, setOpenSignature] = useState<string | null>(null);
  const originPolicy = useQuery({
    queryKey: ["feedback-build-filter", appId],
    queryFn: () => getFeedbackBuildFilter(appId),
  });
  const groups = useQuery({
    queryKey: kind === "crash" ? ["crash-groups", appId, crashType ?? "", buildScope] : ["error-groups", appId, buildScope],
    queryFn: () =>
      kind === "crash"
        ? listCrashGroups(appId, undefined, crashType || undefined, buildScope)
        : listCrashGroups(appId, "error", undefined, buildScope),
  });
  const rows = groups.data?.groups ?? [];
  const open = rows.find((g) => g.signature === openSignature) ?? null;
  const showOrigin = originPolicy.data?.default_enabled === 1;

  return (
    <ListPage
      icon={icon}
      title={title}
      count={groups.data ? rows.length : undefined}
      busy={groups.isLoading}
      toolbar={
        toolbarStart || showOrigin ? (
          <>
            {toolbarStart}
            {showOrigin && (
              <FeedbackBuildScopeSelector
                value={buildScope}
                onChange={(value) => {
                  const next = new URLSearchParams(searchParams);
                  if (value === "standard") next.delete("build_scope");
                  else next.set("build_scope", value);
                  setSearchParams(next, { replace: true });
                }}
              />
            )}
          </>
        ) : undefined
      }
      detail={
        open && (
          <CrashGroupDetail
            key={open.signature}
            appId={appId}
            kind={kind}
            group={open}
            buildScope={buildScope}
            onClose={() => setOpenSignature(null)}
          />
        )
      }
    >
      {above}
      <div className="flex flex-col gap-0.5">
        {groups.isLoading && [0, 1, 2, 3].map((n) => <ListRowSkeleton key={n} cell />)}

        {groups.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{kind === "crash" ? tx("Could not load crashes", "无法加载崩溃") : tx("Could not load errors", "无法加载错误")}</BannerTitle>
              <BannerDescription>{errorMessage(groups.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void groups.refetch()}>{tx("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {groups.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon>{icon}</EmptyStateIcon>
              <EmptyStateTitle>{empty.title}</EmptyStateTitle>
              <EmptyStateDescription>{empty.description}</EmptyStateDescription>
            </EmptyStateContent>
          </EmptyState>
        )}

        {rows.map((g) => (
          <CrashGroupRow
            key={g.signature}
            group={g}
            showType={kind === "crash"}
            selected={openSignature === g.signature}
            onOpen={() => setOpenSignature(g.signature)}
          />
        ))}
      </div>
    </ListPage>
  );
}

function CrashGroupRow({
  group: g,
  showType,
  selected,
  onOpen,
}: {
  group: CrashGroup;
  showType: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const bgKill = g.signature === BACKGROUND_SYSTEM_KILL_SIGNATURE;
  const facts = [
    showType ? crashTypeLabel(g.crash_type, locale) : null,
    g.fatal === 0 ? tx("Non-fatal", "非致命") : null,
    g.versions,
  ].filter(Boolean);
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle className={bgKill ? undefined : "font-mono"}>{groupTitle(g, locale)}</ListRowTitle>
          <ListRowMeta>{timeAgo(g.last_seen, locale)}</ListRowMeta>
        </ListRowTop>
        <ListRowSubtitle>{facts.join(" · ")}</ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>
            {tx(
              `${g.count} report${g.count === 1 ? "" : "s"} · ${g.device_count} device${g.device_count === 1 ? "" : "s"}`,
              `${g.count} 次 · ${g.device_count} 台设备`,
            )}
          </ListRowDescription>
          {g.open_count > 0 && (
            <Badge appearance="soft" variant="warning">{tx(`${g.open_count} open`, `${g.open_count} 个待处理`)}</Badge>
          )}
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function CrashGroupDetail({
  appId,
  kind,
  group: g,
  buildScope,
  onClose,
}: {
  appId: string;
  kind: "crash" | "error";
  group: CrashGroup;
  buildScope: FeedbackBuildScope;
  onClose: () => void;
}) {
  const tx = useText();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const bgKill = g.signature === BACKGROUND_SYSTEM_KILL_SIGNATURE;
  const tickets = useQuery({
    queryKey: ["feedback", appId, "", kind, "", "", g.signature, buildScope],
    queryFn: () => listFeedback(appId, { kind, signature: g.signature, buildScope }),
  });
  const list = tickets.data?.tickets ?? [];
  const typeText = kind === "crash" ? crashTypeLabel(g.crash_type, locale) : tx("Error", "错误");

  return (
    <DetailColumn
      label={groupTitle(g, locale)}
      title={bgKill ? groupTitle(g, locale) : typeText}
      meta={<span className="font-mono">{g.count}</span>}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <CodeBlock>
          <CodeBlockBody>
            <CodeBlockPre aria-label={tx("Signature", "特征")} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              <code>{g.signature}</code>
            </CodeBlockPre>
          </CodeBlockBody>
        </CodeBlock>
        <Text.Sans size="small" variant="muted">
          {kind === "crash"
            ? tx("Crashes are grouped by the exception class and the top frame in your code; ANRs by the main thread's first frame in your code. Stacks are symbolicated when the build's mapping or symbols were uploaded.", "崩溃按异常类和代码中的栈顶帧分组；无响应按主线程在代码中的首个帧分组。上传构建的映射或符号文件后，调用栈会自动符号化。")
            : tx("Errors are grouped by the type of error and where it happened in your code.", "错误按错误类型和代码中发生的位置分组。")}
        </Text.Sans>
        <div className="flex flex-wrap gap-2">
          <Button variant="default" render={<Link to={feedbackLink(appId, kind, g.signature, buildScope)} />} nativeButton={false}>
            {tx("Show in Feedback", "在反馈中查看")}
          </Button>
        </div>
      </div>

      <DetailSection title={tx("Summary", "概况")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{tx("Reports", "次数")}</DescriptionTerm>
            <DescriptionDetails className="font-mono">{g.count}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Devices", "设备")}</DescriptionTerm>
            <DescriptionDetails className="font-mono">{g.device_count}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Open tickets", "待处理工单")}</DescriptionTerm>
            <DescriptionDetails className="font-mono">{g.open_count}</DescriptionDetails>
          </DescriptionItem>
          {kind === "crash" && (
            <DescriptionItem>
              <DescriptionTerm>{tx("Type", "类型")}</DescriptionTerm>
              <DescriptionDetails>
                {typeText}{g.fatal === 0 ? tx(" · non-fatal", " · 非致命") : ""}
              </DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem>
            <DescriptionTerm>{tx("Versions", "版本")}</DescriptionTerm>
            <DescriptionDetails className="[overflow-wrap:anywhere]">{g.versions ?? "—"}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("First seen", "首次出现")}</DescriptionTerm>
            <DescriptionDetails>{new Date(g.first_seen).toLocaleString(locale)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{tx("Last seen", "最近出现")}</DescriptionTerm>
            <DescriptionDetails>{new Date(g.last_seen).toLocaleString(locale)}</DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </DetailSection>

      {(g.by_version?.length ?? 0) > 0 && (
        <DetailSection title={tx("By version", "按版本")}>
          <ListRowGroup>
            {g.by_version!.map((v, idx) => (
              <ListRow
                key={`${v.version_name}-${v.version_code ?? idx}`}
                variant="plain"
                onClick={() =>
                  navigate(feedbackLink(appId, kind, g.signature, buildScope, v.version_code != null ? { version_code: String(v.version_code) } : {}))
                }
              >
                <ListRowBody>
                  <ListRowTitle className="font-mono">
                    {v.version_name}{v.version_code != null ? ` (${v.version_code})` : ""}
                  </ListRowTitle>
                  <ListRowSubtitle>{tx(`${v.device_count} device${v.device_count === 1 ? "" : "s"}`, `${v.device_count} 台设备`)}</ListRowSubtitle>
                </ListRowBody>
                <ListRowValue className="font-mono">{v.count}</ListRowValue>
              </ListRow>
            ))}
          </ListRowGroup>
        </DetailSection>
      )}

      {(g.by_device?.length ?? 0) > 0 && (
        <DetailSection title={tx("By device", "按设备")}>
          <ListRowGroup>
            {g.by_device!.map((d) => (
              <ListRow
                key={d.device_id}
                variant="plain"
                onClick={() =>
                  navigate(feedbackLink(appId, kind, g.signature, buildScope, d.device_id && d.device_id !== "unknown" ? { device_id: d.device_id } : {}))
                }
              >
                <ListRowBody>
                  <ListRowTitle>
                    <span className="font-mono">{d.device_id.slice(0, 12)}</span>
                    {d.device_model ? ` · ${d.device_model}` : ""}
                  </ListRowTitle>
                  <ListRowSubtitle>
                    {tx(`At most ${d.max_daily_count} a day · last ${timeAgo(d.last_seen, locale)}`, `单日最多 ${d.max_daily_count} 次 · 最近 ${timeAgo(d.last_seen, locale)}`)}
                  </ListRowSubtitle>
                </ListRowBody>
                <ListRowValue className="font-mono">{d.count}</ListRowValue>
              </ListRow>
            ))}
          </ListRowGroup>
        </DetailSection>
      )}

      <DetailSection
        title={tickets.data ? `${tx("Tickets", "工单")} (${list.length})` : tx("Tickets", "工单")}
        action={
          list.length > GROUP_TICKETS && (
            <TextLink render={<Link to={feedbackLink(appId, kind, g.signature, buildScope)} />} nativeButton={false}>
              {tx("Show all", "查看全部")}
            </TextLink>
          )
        }
      >
        <div className="-mx-(--column-margin) flex flex-col gap-0.5">
          {tickets.isLoading && [0, 1].map((n) => <ListRowSkeleton key={n} cell />)}
          {tickets.error && (
            <Text.Sans size="small" variant="muted" className="px-(--column-margin)">
              {tx("Could not load the tickets:", "无法加载工单：")} {errorMessage(tickets.error)}
            </Text.Sans>
          )}
          {list.slice(0, GROUP_TICKETS).map((t) => (
            <TicketListRow key={t.id} ticket={t} selected={false} onOpen={() => navigate(`/apps/${appId}/feedback/${t.id}`)} />
          ))}
        </div>
      </DetailSection>
    </DetailColumn>
  );
}
