/**
 * Organization › General: what the organization is and how you belong to it,
 * one fact per row in sections (design: patterns/forms). The organization
 * mirrors a Raft server: its name follows the server's unless an admin
 * renames it here, and roles change on Members.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Building2, Server, UserRound } from "lucide-react";
import {
  Badge,
  Button,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  ListRowValue,
  Skeleton,
  TextLink,
} from "@botiverse/raft-ui";
import { getAuthMe, listOrgs, updateOrg, type Org } from "../../lib/api";
import { errorMessage } from "../../lib/errorMessage";
import { useToast } from "../../components/Toast";
import { useLocale, useText } from "../../lib/locale";
import { SectionNote, SettingsSection } from "../../components/SettingsPage";
import { OrgPage, day, roleLabel, type OrgFrame } from "./OrgPage";

function FactRow({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <ListRow variant="plain" interactive={false} className="flex-wrap">
      <ListRowBody>
        <ListRowTitle>{title}</ListRowTitle>
        {description && <ListRowDescription wrap>{description}</ListRowDescription>}
      </ListRowBody>
      {children}
    </ListRow>
  );
}

export function OrgGeneral({ frame }: { frame: OrgFrame }) {
  const t = useText();
  const { locale } = useLocale();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
  const account = me.data?.account;
  const org = orgs.data?.orgs.find((o) => o.id === frame.orgId);
  const isCurrent = account?.org_id === frame.orgId;
  const role = org?.org_role ?? (isCurrent ? account?.org_role : null) ?? null;
  const serverName = (isCurrent ? account?.server_slug : null) ?? org?.slug ?? null;
  const externalId = org?.external_id ?? (isCurrent ? account?.server_id : null) ?? null;
  const loading = me.isLoading || orgs.isLoading;
  const canRename = role === "owner" || role === "admin";
  const [renaming, setRenaming] = useState(false);

  return (
    <OrgPage frame={frame} layout="settings" busy={loading}>
      {loading && <Skeleton className="h-40 w-full" />}
      {!loading && (
        <>
          <SettingsSection id="org-general-org" icon={<Building2 />} title={t("Organization", "组织")}>
            <ListRowGroup className="@container">
              <FactRow
                title={t("Name", "名称")}
                description={org?.name_customized
                  ? t(`Set in Hands. The Raft server is called ${org.raft_name ?? "—"}.`, `在 Hands 中设置。Raft 服务器名为 ${org.raft_name ?? "—"}。`)
                  : t("Follows the Raft server's name.", "跟随 Raft 服务器的名称。")}
              >
                <ListRowValue>{org?.name ?? serverName ?? frame.orgId}</ListRowValue>
                {canRename && org && <Button variant="outline" onClick={() => setRenaming(true)}>{t("Rename", "重命名")}</Button>}
              </FactRow>
              {org?.slug && (
                <FactRow title={t("Slug", "标识")}>
                  <ListRowValue className="font-mono">{org.slug}</ListRowValue>
                </FactRow>
              )}
              <FactRow
                title={t("Organization ID", "组织 ID")}
                description={t("Used by the CLI and the API to pick this organization.", "命令行和 API 用它来选择此组织。")}
              >
                <CopyableCodeRoot size="sm" className="w-auto max-w-full">
                  <CopyableCode className="[overflow-wrap:anywhere]">{frame.orgId}</CopyableCode>
                  <CopyableCodeAction aria-label={t("Copy organization ID", "复制组织 ID")} />
                </CopyableCodeRoot>
              </FactRow>
              {org && (
                <FactRow title={t("Created", "创建时间")}>
                  <ListRowValue>{day(org.created_at, locale)}</ListRowValue>
                </FactRow>
              )}
              {org?.archived ? (
                <FactRow title={t("Status", "状态")}>
                  <Badge appearance="soft" variant="muted">{t("Archived", "已归档")}</Badge>
                </FactRow>
              ) : null}
            </ListRowGroup>
          </SettingsSection>

          <SettingsSection id="org-general-raft" icon={<Server />} title={t("Raft server", "Raft 服务器")}>
            <ListRowGroup className="@container">
              <FactRow title={t("Provider", "提供方")}>
                <ListRowValue>{org?.external_provider === "raft" || account?.provider === "raft" ? "Raft" : (org?.external_provider ?? account?.provider ?? "—")}</ListRowValue>
              </FactRow>
              {serverName && (
                <FactRow title={t("Server", "服务器")}>
                  <ListRowValue className="font-mono">{serverName}</ListRowValue>
                </FactRow>
              )}
              <FactRow title={t("Server ID", "服务器 ID")}>
                <ListRowValue className="font-mono [overflow-wrap:anywhere]">{externalId ?? "—"}</ListRowValue>
              </FactRow>
            </ListRowGroup>
            <SectionNote>
              {t("People sign in with Raft; membership of the Raft server gives access to this organization.", "成员通过 Raft 登录；加入该 Raft 服务器即可访问此组织。")}
            </SectionNote>
          </SettingsSection>

          {account && (
            <SettingsSection id="org-general-you" icon={<UserRound />} title={t("Your access", "你的权限")}>
              <ListRowGroup className="@container">
                <FactRow title={t("Role in this organization", "在此组织中的角色")}>
                  <ListRowValue>{role ? roleLabel(role, t) : "—"}</ListRowValue>
                </FactRow>
                <FactRow title={t("Signed in as", "登录身份")}>
                  <ListRowValue>
                    {account.principal_type === "agent" ? t("Agent (Raft)", "智能体（Raft）") : t("Person (Raft)", "用户（Raft）")}
                  </ListRowValue>
                </FactRow>
                <FactRow title={t("Role on the Raft server", "Raft 服务器角色")}>
                  <ListRowValue>{account.server_role ? roleLabel(account.server_role, t) : "—"}</ListRowValue>
                </FactRow>
              </ListRowGroup>
              <SectionNote>
                {t("Owners and admins change roles on ", "所有者和管理员可以在")}
                <TextLink render={<Link to={`/orgs/${frame.orgId}/members`} />}>{t("Members", "成员")}</TextLink>
                {t(".", "页面修改角色。")}
              </SectionNote>
            </SettingsSection>
          )}
        </>
      )}
      {renaming && org && <RenameDialog org={org} onClose={() => setRenaming(false)} />}
    </OrgPage>
  );
}

function RenameDialog({ org, onClose }: { org: Org; onClose: () => void }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const save = useMutation({
    mutationFn: (next: string | null) => updateOrg(org.id, { name: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orgs"] });
      void qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast.show({ kind: "success", title: t("Organization renamed", "组织已重命名") });
      onClose();
    },
  });
  const trimmed = name.trim();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Rename organization", "重命名组织")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <DialogDescription>
            {t("The new name is used everywhere in Hands and stays when people sign in. The Raft server keeps its own name.", "新名称会用于 Hands 的所有页面，登录后也不会变。Raft 服务器的名称保持不变。")}
          </DialogDescription>
          <Field>
            <FieldLabel>{t("Name", "名称")}</FieldLabel>
            <Input value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
            {save.error && <FieldDescription className="text-danger-strong">{errorMessage(save.error)}</FieldDescription>}
          </Field>
        </DialogBody>
        <DialogFooter>
          {org.name_customized ? (
            <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
              {t("Use the Raft server's name", "改用 Raft 服务器的名称")}
            </Button>
          ) : null}
          <Button disabled={save.isPending || trimmed.length === 0 || trimmed === org.name} onClick={() => save.mutate(trimmed)}>
            {t("Save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
