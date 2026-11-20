/**
 * The frame of an organization page (/orgs/:orgId/:tab): the panel header
 * names the page, with the organization beside it and, on a phone, Back to
 * the organization's list of pages. Under it an optional toolbar, then the
 * content, which scrolls alone. A list page opens its items in a column
 * beside it (DetailColumn); below the two-column width the column takes the
 * page's place.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import {
  Banner,
  BannerDescription,
  BannerTitle,
  Panel,
  PanelAction,
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelHeading,
  PanelMeta,
  PanelScrollViewport,
  PanelTitle,
} from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";
import { getAuthMe, listOrgs } from "../../lib/api";
import { useText } from "../../lib/locale";

export type T = ReturnType<typeof useText>;

export const ROLE_ZH: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "查看者", publisher: "发布者", developer: "开发者" };
export const roleText = (role: string, t: T) => t(role, ROLE_ZH[role] ?? role);
export const roleLabel = (role: string, t: T) =>
  t(role.charAt(0).toUpperCase() + role.slice(1), ROLE_ZH[role] ?? role);

export function useOrgName(orgId: string) {
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
  return (
    orgs.data?.orgs.find((org) => org.id === orgId)?.name ??
    (account?.org_id === orgId ? account?.server_slug ?? account?.server_id : undefined) ??
    orgId
  );
}

/** What every organization page's frame needs, handed down by OrgSettings. */
export type OrgFrame = {
  orgId: string;
  title: string;
  icon: ReactNode;
  /** A line above the content, such as the org-mismatch warning. */
  notice?: ReactNode;
};

const CONTENT = {
  list: "flex w-full max-w-5xl flex-col gap-6 pt-3 pb-10",
  settings: "flex w-full max-w-3xl flex-col gap-8 px-(--column-margin) pt-4 pb-10",
  wide: "w-full max-w-5xl px-(--column-margin) py-4",
} as const;

export function OrgPage({
  frame,
  layout = "list",
  count,
  toolbar,
  busy,
  detail,
  children,
}: {
  frame: OrgFrame;
  /** `list`: rows run to the panel's edges; `settings`: a 3xl column of
   *  sections; `wide`: a padded 5xl column. */
  layout?: keyof typeof CONTENT;
  count?: number | undefined;
  toolbar?: ReactNode;
  busy?: boolean;
  detail?: ReactNode;
  children: ReactNode;
}) {
  const t = useText();
  const orgName = useOrgName(frame.orgId);
  return (
    <div className="flex min-h-0 flex-1">
      <Panel
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", detail && "max-lg:hidden")}
        aria-label={`${frame.title} · ${orgName}`}
      >
        <PanelHeader>
          <PanelAction
            className="md:hidden"
            aria-label={t("Back", "返回")}
            render={<Link to={`/orgs/${frame.orgId}`} />}
            nativeButton={false}
            activateOnTouchEnd
          >
            <ArrowLeft aria-hidden="true" />
          </PanelAction>
          <PanelHeaderIcon className="max-md:hidden">{frame.icon}</PanelHeaderIcon>
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle render={<h1 />}>{frame.title}</PanelTitle>
            </PanelHeading>
            <PanelMeta>
              {orgName}
              {count !== undefined && <span className="font-mono"> · {count}</span>}
            </PanelMeta>
          </PanelHeaderContent>
        </PanelHeader>
        {toolbar && (
          <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-seam px-(--column-margin) py-1.5">
            {toolbar}
          </div>
        )}
        <PanelScrollViewport className="min-h-0 flex-1" contentClassName={CONTENT[layout]} aria-busy={busy || undefined}>
          {frame.notice && <div className={layout === "list" ? "px-(--column-margin)" : "mb-4"}>{frame.notice}</div>}
          {children}
        </PanelScrollViewport>
      </Panel>
      {detail}
    </div>
  );
}

/** The URL's organization is not the one the session is in. */
export function OrgMismatchBanner({ orgId, currentOrgId }: { orgId: string; currentOrgId: string }) {
  const t = useText();
  return (
    <Banner status="warning">
      <AlertTriangle aria-hidden="true" />
      <BannerTitle>{t("This is not your current organization", "这不是你当前的组织")}</BannerTitle>
      <BannerDescription>
        {t(
          `The link is for ${orgId}; you are signed in to ${currentOrgId}. Switch organization to manage it.`,
          `链接中的组织是 ${orgId}，你当前在 ${currentOrgId}。切换组织后才能管理它。`,
        )}
      </BannerDescription>
    </Banner>
  );
}

/** "Nov 21, 2026" in the reader's language. */
export function day(ts: number, locale: string) {
  return new Date(ts).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** "Nov 21, 2026, 14:03" in the reader's language. */
export function dateTime(ts: number, locale: string) {
  return new Date(ts).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
