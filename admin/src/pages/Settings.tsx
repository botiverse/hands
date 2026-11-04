import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Separator,
  TextHeading,
  TextMono,
  TextSans,
} from "raft-ui";
import { getAuthMe } from "../lib/api";
import { AppearanceSettings } from "../components/AppearanceSettings";
import { LanguagePicker, useText } from "../lib/locale";

function OrgRoleBadge({ role }: { role: string | null }) {
  const t = useText();
  if (!role) return <>—</>;
  if (role === "owner") return <Badge variant="accent">{t("owner", "所有者")}</Badge>;
  if (role === "admin") return <Badge variant="information">{t("admin", "管理员")}</Badge>;
  if (role === "member") return <>{t("member", "成员")}</>;
  if (role === "viewer") return <>{t("viewer", "查看者")}</>;
  return <>{role}</>;
}

export function Settings() {
  const t = useText();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const raftCallbackUrl = `${window.location.origin}/login/raft/callback`;

  return (
    <div className="space-y-6">
      <TextHeading level={1} className="text-2xl leading-8">
        {t("Settings", "设置")}
      </TextHeading>

      {/* Current account + org context */}
      {account && (
        <section className="border-t border-line-hairline pt-5">
          <h3 className="mb-3 text-sm font-medium text-foreground-strong">
            {t("Current account", "当前账号")}
          </h3>
          <div className="space-y-4">
            <DescriptionList direction="horizontal">
              <DescriptionItem>
                <DescriptionTerm>{t("Display name", "显示名称")}</DescriptionTerm>
                <DescriptionDetails>{account.display_name}</DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>{t("Principal type", "身份类型")}</DescriptionTerm>
                <DescriptionDetails>
                  {account.principal_type === "agent" ? (
                    <Badge variant="accent">{t("agent (Raft)", "智能体（Raft）")}</Badge>
                  ) : account.principal_type === "human" ? (
                    <>{t("human (Raft)", "用户（Raft）")}</>
                  ) : (
                    <>{account.principal_type}</>
                  )}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>{t("Server", "服务器")}</DescriptionTerm>
                <DescriptionDetails className="font-mono">
                  {account.server_slug ?? account.server_id}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>{t("Server role (from Raft)", "服务器角色（来自 Raft）")}</DescriptionTerm>
                <DescriptionDetails>
                  {account.server_role ?? "—"}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>{t("Org id", "组织 ID")}</DescriptionTerm>
                <DescriptionDetails className="font-mono">
                  {account.org_id ?? "—"}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>{t("Your org role", "你的组织角色")}</DescriptionTerm>
                <DescriptionDetails>
                  <OrgRoleBadge role={account.org_role} />
                </DescriptionDetails>
              </DescriptionItem>
            </DescriptionList>
            <Separator />
            <TextSans size="caption">
              {t("Signed in with Raft. To change role, ask an organization owner or admin in Organization settings.", "已通过 Raft 登录。如需更改角色，请联系组织所有者或管理员，在组织设置中调整。")}
            </TextSans>
          </div>
        </section>
      )}

      {/* Appearance: RUI theme family + mode; persisted per browser */}
      <section className="border-t border-line-hairline pt-5">
        <h3 className="mb-1 text-sm font-medium text-foreground-strong">
          {t("Appearance", "外观")}
        </h3>
        <p className="mb-3 text-sm text-foreground-muted">
          {t("Choose how the dashboard looks. Preferences are saved in this browser.", "选择控制台的外观。设置会保存在当前浏览器中。")}
        </p>
        <AppearanceSettings />
      </section>

      <section className="border-t border-line-hairline pt-5">
        <h3 className="mb-3 text-sm font-medium text-foreground-strong">{t("Language", "语言")}</h3>
        <LanguagePicker />
      </section>

      {/* Infrastructure (existing static info) */}
      <section className="border-t border-line-hairline pt-5">
        <h3 className="mb-3 text-sm font-medium text-foreground-strong">
          {t("Infrastructure", "基础设施")}
        </h3>
        <div className="space-y-3">
          <TextSans size="small">
            {t("Admin access uses Login with Raft. Access follows your Raft organization membership and role.", "管理员通过 Raft 登录，访问权限由你的 Raft 组织成员身份和角色决定。")}
          </TextSans>
          <div className="space-y-1">
            <TextSans size="caption">{t("Raft Callback URL", "Raft 回调地址")}</TextSans>
            <TextMono size="code" className="break-all">
              {raftCallbackUrl}
            </TextMono>
          </div>
        </div>
      </section>
    </div>
  );
}
