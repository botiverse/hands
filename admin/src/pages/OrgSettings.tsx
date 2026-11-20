/**
 * The organization's pages (/orgs/:orgId/:tab): General, Members, Invites,
 * Audit, Webhooks and Signing. On desktop the sidebar lists them; on a phone
 * the bare org route is OrgSettingsList, a row per page.
 *
 * Each page draws its own frame (pages/org/OrgPage.tsx) and lives in its own
 * file under pages/org/, except Signing (pages/SigningIdentities.tsx).
 */

import { useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  Building2,
  KeyRound,
  MailPlus,
  ScrollText,
  SlidersHorizontal,
  Users,
  Webhook as WebhookIcon,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Panel,
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelHeading,
  PanelMeta,
  PanelTitle,
  SidebarBody,
  SidebarContent,
  SidebarItem,
  SidebarItemContent,
  SidebarItemIcon,
  SidebarItemTitle,
  SidebarList,
  SidebarRoot,
  SidebarSection,
} from "@botiverse/raft-ui";
import { getAuthMe } from "../lib/api";
import { useText } from "../lib/locale";
import { SigningTab } from "./SigningIdentities";
import { OrgAudit } from "./org/OrgAudit";
import { OrgGeneral } from "./org/OrgGeneral";
import { OrgInvites } from "./org/OrgInvites";
import { OrgMembers } from "./org/OrgMembers";
import { OrgMismatchBanner, OrgPage, useOrgName, type OrgFrame } from "./org/OrgPage";
import { OrgWebhooks } from "./org/OrgWebhooks";

const ORG_SETTINGS_TAB_ICONS: Record<OrgSettingsTab, LucideIcon> = {
  general: SlidersHorizontal,
  members: Users,
  invites: MailPlus,
  audit: ScrollText,
  webhooks: WebhookIcon,
  signing: KeyRound,
};
const ORG_SETTINGS_TAB_LABELS: Record<OrgSettingsTab, string> = {
  general: "General",
  members: "Members",
  invites: "Invites",
  audit: "Audit",
  webhooks: "Webhooks",
  signing: "Signing",
};
const ORG_SETTINGS_TAB_LABELS_ZH: Record<OrgSettingsTab, string> = { general: "常规", members: "成员", invites: "邀请", audit: "审计", webhooks: "Webhooks", signing: "签名" };

export const ORG_SETTINGS_TABS = [
  "general",
  "members",
  "invites",
  "audit",
  "webhooks",
  "signing",
] as const;

export type OrgSettingsTab = (typeof ORG_SETTINGS_TABS)[number];

export function isOrgSettingsTab(tab: string | undefined): tab is OrgSettingsTab {
  return ORG_SETTINGS_TABS.some((candidate) => candidate === tab);
}

/** The organization's own pages, in order, with their sidebar icons. The
 *  desktop sidebar lists them on `/orgs/...` routes; on a phone they are the
 *  rows of the organization's list page. */
export const ORG_SETTINGS_NAV: ReadonlyArray<{
  tab: OrgSettingsTab;
  label: string;
  labelZh: string;
  icon: LucideIcon;
}> = ORG_SETTINGS_TABS.map((tab) => ({
  tab,
  label: ORG_SETTINGS_TAB_LABELS[tab],
  labelZh: ORG_SETTINGS_TAB_LABELS_ZH[tab],
  icon: ORG_SETTINGS_TAB_ICONS[tab],
}));

const DESKTOP_QUERY = "(min-width: 768px)";

/** Whether the viewport is at least `md`, where the sidebar shows. */
export function useIsDesktop() {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const query = window.matchMedia(DESKTOP_QUERY);
      query.addEventListener?.("change", onChange);
      return () => query.removeEventListener?.("change", onChange);
    },
    () => typeof window.matchMedia !== "function" || window.matchMedia(DESKTOP_QUERY).matches,
  );
}

/** The organization's page on a phone (patterns: products/raft-chat/settings,
 *  "on a phone ... each row opens another pushed page, with Back to the
 *  list"): its header, then a row per section. Desktop never shows it; the
 *  sidebar holds these rows there. */
export function OrgSettingsList({ orgId }: { orgId: string }) {
  const t = useText();
  const orgName = useOrgName(orgId);
  return (
    <Panel className="flex min-h-0 flex-1 flex-col" aria-label={orgName}>
      <PanelHeader>
        <PanelHeaderIcon>
          <Building2 aria-hidden="true" />
        </PanelHeaderIcon>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h1 />}>{orgName}</PanelTitle>
          </PanelHeading>
          <PanelMeta>{t("Organization", "组织")}</PanelMeta>
        </PanelHeaderContent>
      </PanelHeader>
      <SidebarRoot render={<nav aria-label={orgName} />} className="min-h-0 flex-1">
        <SidebarBody>
          <SidebarContent>
            <SidebarSection>
              <SidebarList>
                {ORG_SETTINGS_NAV.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarItem key={item.tab} render={<Link to={`/orgs/${orgId}/${item.tab}`} />}>
                      <SidebarItemIcon aria-hidden>
                        <Icon />
                      </SidebarItemIcon>
                      <SidebarItemContent>
                        <SidebarItemTitle>{t(item.label, item.labelZh)}</SidebarItemTitle>
                      </SidebarItemContent>
                    </SidebarItem>
                  );
                })}
              </SidebarList>
            </SidebarSection>
          </SidebarContent>
        </SidebarBody>
      </SidebarRoot>
    </Panel>
  );
}

export function OrgSettings({
  orgId,
  tab,
}: {
  orgId: string;
  tab: OrgSettingsTab;
}) {
  const t = useText();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const currentOrgId = account?.org_id ?? null;
  const currentRole = account?.org_role ?? null;
  const isOwnerOrAdmin = currentRole === "owner" || currentRole === "admin";
  const Icon = ORG_SETTINGS_TAB_ICONS[tab];

  // The pages are the sidebar's rows on desktop and the rows of the
  // organization's list page on a phone, so each page's header names the
  // page (its one level-1 heading) and, on a phone, has Back to that list.
  const frame: OrgFrame = {
    orgId,
    title: t(ORG_SETTINGS_TAB_LABELS[tab], ORG_SETTINGS_TAB_LABELS_ZH[tab]),
    icon: <Icon aria-hidden="true" />,
    notice: currentOrgId && currentOrgId !== orgId ? <OrgMismatchBanner orgId={orgId} currentOrgId={currentOrgId} /> : undefined,
  };

  switch (tab) {
    case "general":
      return <OrgGeneral frame={frame} />;
    case "members":
      return <OrgMembers key={orgId} frame={frame} currentAccountId={account?.id ?? null} currentRole={currentRole} />;
    case "invites":
      return <OrgInvites key={orgId} frame={frame} canManage={isOwnerOrAdmin} />;
    case "audit":
      return <OrgAudit key={orgId} frame={frame} canView={isOwnerOrAdmin || currentRole === "member"} />;
    case "webhooks":
      return <OrgWebhooks key={orgId} frame={frame} canManage={isOwnerOrAdmin} />;
    case "signing":
      return (
        <OrgPage frame={frame} layout="wide">
          <SigningTab orgId={orgId} canManage={isOwnerOrAdmin} />
        </OrgPage>
      );
  }
}
