/**
 * Account settings (/settings): one setting per row, grouped in sections
 * (design: patterns/forms). Appearance and language apply at once and are
 * kept in this browser; the account and sign-in sections say who you are
 * and how Hands signs you in.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LogIn, Palette, Settings as SettingsIcon, UserRound } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowSubtitle,
  ListRowTitle,
  ListRowValue,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@botiverse/raft-ui";
import { getAuthMe, listOrgs } from "../lib/api";
import { AppearanceSettings } from "../components/AppearanceSettings";
import { SectionNote, SettingsPage, SettingsSection } from "../components/SettingsPage";
import { useLocale, useText, type Locale } from "../lib/locale";
import { roleLabel } from "./org/OrgPage";

const LANGUAGES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文" };

function FactRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTitle>{title}</ListRowTitle>
      </ListRowBody>
      {children}
    </ListRow>
  );
}

function LanguageRow() {
  const t = useText();
  const { locale, setLocale } = useLocale();
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTitle id="settings-language-title">{t("Language", "语言")}</ListRowTitle>
        <ListRowDescription wrap>{t("For the console and the pages it opens.", "用于控制台及其打开的页面。")}</ListRowDescription>
      </ListRowBody>
      <Select items={LANGUAGES} value={locale} onValueChange={(v) => { if (v) setLocale(v as Locale); }}>
        <SelectTrigger className="w-36 shrink-0" aria-labelledby="settings-language-title">
          <SelectValue />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {(Object.keys(LANGUAGES) as Locale[]).map((l) => (
              <SelectItem key={l} value={l}>{LANGUAGES[l]}</SelectItem>
            ))}
          </SelectList>
        </SelectContent>
      </Select>
    </ListRow>
  );
}

export function Settings() {
  const t = useText();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
  const account = me.data?.account;
  const org = account?.org_id ? orgs.data?.orgs.find((o) => o.id === account.org_id) : undefined;
  const raftCallbackUrl = `${window.location.origin}/login/raft/callback`;

  return (
    <SettingsPage icon={<SettingsIcon aria-hidden="true" />} title={t("Settings", "设置")} busy={me.isLoading}>
      <SettingsSection id="settings-appearance" icon={<Palette />} title={t("Appearance", "外观")}>
        <ListRowGroup className="@container">
          <AppearanceSettings />
          <LanguageRow />
        </ListRowGroup>
      </SettingsSection>

      <SettingsSection id="settings-account" icon={<UserRound />} title={t("Account", "账号")}>
        {me.isLoading && <Skeleton className="h-32 w-full" />}
        {account && (
          <>
            <ListRowGroup>
              <ListRow variant="plain" interactive={false}>
                <Avatar size="md" type={account.principal_type === "agent" ? "agent" : "human"}>
                  {account.avatar_url ? <AvatarImage src={account.avatar_url} alt="" /> : null}
                  <AvatarFallback>{account.display_name.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <ListRowBody>
                  <ListRowTitle>{account.display_name}</ListRowTitle>
                  <ListRowSubtitle>
                    {account.username && <span className="font-mono">@{account.username}</span>}
                    {account.username && " · "}
                    {account.principal_type === "agent" ? t("Agent (Raft)", "智能体（Raft）") : t("Person (Raft)", "用户（Raft）")}
                  </ListRowSubtitle>
                </ListRowBody>
                {account.principal_type === "agent" && <Badge appearance="outline" className="shrink-0">{t("agent", "智能体")}</Badge>}
              </ListRow>
              <FactRow title={t("Raft server", "Raft 服务器")}>
                <ListRowValue className="font-mono">{account.server_slug ?? account.server_id}</ListRowValue>
              </FactRow>
              <FactRow title={t("Role on the server", "服务器角色")}>
                <ListRowValue>{account.server_role ? roleLabel(account.server_role, t) : "—"}</ListRowValue>
              </FactRow>
              {account.org_id ? (
                <ListRow variant="plain" render={<Link to={`/orgs/${account.org_id}/general`} />}>
                  <ListRowBody>
                    <ListRowTitle>{t("Organization", "组织")}</ListRowTitle>
                    <ListRowDescription>{org?.name ?? account.org_id}</ListRowDescription>
                  </ListRowBody>
                  <ListRowValue>{account.org_role ? roleLabel(account.org_role, t) : "—"}</ListRowValue>
                  <ListRowChevron />
                </ListRow>
              ) : (
                <FactRow title={t("Organization", "组织")}>
                  <ListRowValue>—</ListRowValue>
                </FactRow>
              )}
            </ListRowGroup>
            <SectionNote>
              {t("Your account comes from Raft. An owner or admin of the organization changes your role.", "账号来自 Raft。组织的所有者或管理员可以修改你的角色。")}
            </SectionNote>
          </>
        )}
      </SettingsSection>

      <SettingsSection id="settings-sign-in" icon={<LogIn />} title={t("Sign-in", "登录")}>
        <ListRowGroup className="@container">
          <ListRow variant="plain" interactive={false} className="flex-wrap">
            <ListRowBody>
              <ListRowTitle>{t("Raft callback URL", "Raft 回调地址")}</ListRowTitle>
              <ListRowDescription wrap>{t("Where Raft returns after Login with Raft. Register it with the Raft app.", "Raft 登录后返回的地址。请在 Raft 应用中登记。")}</ListRowDescription>
            </ListRowBody>
            <CopyableCodeRoot size="sm" className="max-w-full @lg:max-w-72">
              <CopyableCode className="[overflow-wrap:anywhere]">{raftCallbackUrl}</CopyableCode>
              <CopyableCodeAction aria-label={t("Copy callback URL", "复制回调地址")} />
            </CopyableCodeRoot>
          </ListRow>
        </ListRowGroup>
        <SectionNote>
          {t("Hands signs everyone in with Raft; access follows the Raft organization and role.", "Hands 通过 Raft 登录；访问权限由 Raft 组织成员身份和角色决定。")}
        </SectionNote>
      </SettingsSection>
    </SettingsPage>
  );
}
