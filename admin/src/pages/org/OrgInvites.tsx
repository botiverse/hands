/**
 * Organization › Invites: a page of a list. The toolbar narrows by status
 * (the server's ?status=) and holds New invite. Each invite is a row with its
 * status; opening one shows a column with its details, a fresh link to copy
 * (the earlier link stops working) and revoking it, which a dialog confirms.
 *
 * Creating an invite is a dialog that ends on the link, ready to copy: the
 * link is shown only then, and is also put on the clipboard.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Link2, Mail, MailPlus, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  RadioGroup,
  RadioGroupItem,
  Text,
  Textarea,
} from "@botiverse/raft-ui";
import type { BadgeProps } from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { createOrgInvite, listOrgInvites, resendOrgInvite, revokeOrgInvite, type Invite } from "../../lib/api";
import { errorMessage } from "../../lib/errorMessage";
import { useLocale, useText } from "../../lib/locale";
import { useToast } from "../../components/Toast";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { DetailColumn, DetailSection } from "../../components/ListPage";
import { FilterSelect } from "../AuditLog";
import { OrgPage, dateTime, day, roleLabel, type OrgFrame, type T } from "./OrgPage";

const STATUS: Record<Invite["status"], { en: string; zh: string; variant: NonNullable<BadgeProps["variant"]> }> = {
  pending: { en: "Pending", zh: "待接受", variant: "information" },
  accepted: { en: "Accepted", zh: "已接受", variant: "success" },
  revoked: { en: "Revoked", zh: "已撤销", variant: "muted" },
  expired: { en: "Expired", zh: "已过期", variant: "warning" },
};

const DAY = 86_400_000;

/** A pending invite past its date reads as expired. */
function statusOf(inv: Invite): Invite["status"] {
  return inv.status === "pending" && inv.expires_at < Date.now() ? "expired" : inv.status;
}

function StatusBadge({ status }: { status: Invite["status"] }) {
  const t = useText();
  const s = STATUS[status] ?? { en: status, zh: status, variant: "muted" as const };
  return <Badge appearance="soft" variant={s.variant} className="shrink-0">{t(s.en, s.zh)}</Badge>;
}

function expiresText(inv: Invite, locale: string, t: T) {
  const days = Math.ceil((inv.expires_at - Date.now()) / DAY);
  if (days <= 0) return t(`expired ${day(inv.expires_at, locale)}`, `${day(inv.expires_at, locale)} 过期`);
  return days === 1 ? t("expires within a day", "1 天内过期") : t(`expires in ${days} days`, `${days} 天后过期`);
}

function copy(url: string) {
  navigator.clipboard?.writeText(url).catch(() => {});
}

export function OrgInvites({ frame, canManage }: { frame: OrgFrame; canManage: boolean }) {
  const t = useText();
  const { orgId } = frame;
  const [statusFilter, setStatusFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const invites = useQuery({
    queryKey: ["org-invites", orgId, statusFilter],
    queryFn: () => listOrgInvites(orgId, statusFilter || undefined),
  });
  const rows = invites.data?.invites ?? [];
  const open = rows.find((i) => i.id === openId) ?? null;

  return (
    <OrgPage
      frame={frame}
      count={invites.data ? rows.length : undefined}
      busy={invites.isLoading}
      toolbar={
        <>
          <FilterSelect
            label={t("Status", "状态")}
            items={{
              "": t("All statuses", "全部状态"),
              pending: t("Pending", "待接受"),
              accepted: t("Accepted", "已接受"),
              revoked: t("Revoked", "已撤销"),
              expired: t("Expired", "已过期"),
            }}
            value={statusFilter}
            onChange={setStatusFilter}
          />
          {canManage && (
            <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("New invite", "新建邀请")}
            </Button>
          )}
        </>
      }
      detail={
        open && (
          <InviteColumn
            key={open.id}
            orgId={orgId}
            invite={open}
            canManage={canManage}
            onClose={() => setOpenId(null)}
          />
        )
      }
    >
      {!canManage && (
        <div className="px-(--column-margin)">
          <Text.Sans size="small" variant="muted">{t("Owners and admins create and revoke invites.", "所有者和管理员可以创建和撤销邀请。")}</Text.Sans>
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {invites.isLoading && [0, 1, 2].map((n) => <ListRowSkeleton key={n} cell leading />)}
        {invites.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load the invites", "无法加载邀请")}</BannerTitle>
              <BannerDescription>{errorMessage(invites.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void invites.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}
        {invites.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><MailPlus aria-hidden="true" /></EmptyStateIcon>
              {statusFilter ? (
                <>
                  <EmptyStateTitle>{t("No invites match", "没有符合条件的邀请")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Pick another status.", "换一个状态试试。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{t("No invites yet", "还没有邀请")}</EmptyStateTitle>
                  <EmptyStateDescription>
                    {t("An invite is a link for one person. It works for 7 days.", "邀请是发给一个人的链接，7 天内有效。")}
                  </EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
            {canManage && !statusFilter && (
              <EmptyStateActions>
                <Button variant="outline" onClick={() => setCreating(true)}>{t("New invite", "新建邀请")}</Button>
              </EmptyStateActions>
            )}
          </EmptyState>
        )}
        {rows.map((inv) => (
          <InviteRow key={inv.id} invite={inv} selected={openId === inv.id} onOpen={() => setOpenId(inv.id)} />
        ))}
      </div>
      {creating && <CreateInviteDialog orgId={orgId} onClose={() => setCreating(false)} />}
    </OrgPage>
  );
}

function InviteRow({ invite: inv, selected, onOpen }: { invite: Invite; selected: boolean; onOpen: () => void }) {
  const t = useText();
  const { locale } = useLocale();
  const status = statusOf(inv);
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowIcon><Mail /></ListRowIcon>
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle className="min-w-0 flex-1">{inv.email}</ListRowTitle>
          <StatusBadge status={status} />
        </ListRowTop>
        <ListRowSubtitle>
          {roleLabel(inv.role, t)}
          {inv.app_name ? ` · ${inv.app_name}` : ""}
          {" · "}
          {status === "pending" || status === "expired"
            ? expiresText(inv, locale, t)
            : status === "accepted" && inv.accepted_at
              ? t(`accepted ${day(inv.accepted_at, locale)}`, `${day(inv.accepted_at, locale)} 接受`)
              : status === "revoked" && inv.revoked_at
                ? t(`revoked ${day(inv.revoked_at, locale)}`, `${day(inv.revoked_at, locale)} 撤销`)
                : t(`sent ${day(inv.created_at, locale)}`, `${day(inv.created_at, locale)} 发出`)}
        </ListRowSubtitle>
      </ListRowBody>
    </ListRow>
  );
}

function InviteLink({ url, onCopy }: { url: string; onCopy?: () => void }) {
  const t = useText();
  return (
    <CopyableCodeRoot size="sm" {...(onCopy ? { onCopy } : {})}>
      <CopyableCode className="[overflow-wrap:anywhere]">{url}</CopyableCode>
      <CopyableCodeAction aria-label={t("Copy invite link", "复制邀请链接")} />
    </CopyableCodeRoot>
  );
}

function InviteColumn({
  orgId,
  invite: inv,
  canManage,
  onClose,
}: {
  orgId: string;
  invite: Invite;
  canManage: boolean;
  onClose: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [revoking, setRevoking] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const status = statusOf(inv);
  const actionable = canManage && inv.status === "pending";

  const refresh = () => qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
  const resend = useMutation({
    mutationFn: () => resendOrgInvite(orgId, inv.id),
    onSuccess: (data) => {
      setLink(data.invite_url);
      copy(data.invite_url);
      toast.show({ kind: "success", title: t("New link copied", "新链接已复制") });
      void refresh();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Refresh failed", "刷新失败"), description: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: () => revokeOrgInvite(orgId, inv.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Invite revoked", "邀请已撤销") });
      setLink(null);
      void refresh();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Revoke failed", "撤销失败"), description: errorMessage(e) }),
  });

  return (
    <DetailColumn label={inv.email} title={inv.email} meta={<StatusBadge status={status} />} onClose={onClose}>
      {actionable && (
        <DetailSection title={t("Link", "链接")}>
          {link ? (
            <>
              <InviteLink url={link} onCopy={() => toast.show({ kind: "success", title: t("Copied invite link", "已复制邀请链接") })} />
              <Text.Sans size="small" variant="muted">
                {t("Send it to them yourself. Earlier links no longer work.", "请自行发送给对方。之前的链接已失效。")}
              </Text.Sans>
            </>
          ) : (
            <ListRowGroup>
              <ListRow variant="plain" onClick={() => resend.mutate()} disabled={resend.isPending}>
                <ListRowIcon><Link2 /></ListRowIcon>
                <ListRowBody>
                  <ListRowTitle>{t("Copy a new link", "复制新链接")}</ListRowTitle>
                  <ListRowDescription wrap>
                    {t("Hands shows a link only once. A new one works for 7 more days; the earlier link stops working.", "链接只显示一次。新链接再有效 7 天，之前的链接会失效。")}
                  </ListRowDescription>
                </ListRowBody>
              </ListRow>
            </ListRowGroup>
          )}
        </DetailSection>
      )}

      <DetailSection title={t("Details", "详情")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{t("Role", "角色")}</DescriptionTerm>
            <DescriptionDetails>{roleLabel(inv.role, t)}</DescriptionDetails>
          </DescriptionItem>
          {inv.app_name && (
            <DescriptionItem>
              <DescriptionTerm>{t("App", "应用")}</DescriptionTerm>
              <DescriptionDetails>{inv.app_name}</DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem>
            <DescriptionTerm>{t("Sent", "发出")}</DescriptionTerm>
            <DescriptionDetails>
              {dateTime(inv.created_at, locale)}
              {inv.invited_by_display_name && <span className="text-foreground-muted">{t(` by ${inv.invited_by_display_name}`, `，由 ${inv.invited_by_display_name}`)}</span>}
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{status === "expired" ? t("Expired", "已过期") : t("Expires", "过期")}</DescriptionTerm>
            <DescriptionDetails>{dateTime(inv.expires_at, locale)}</DescriptionDetails>
          </DescriptionItem>
          {inv.accepted_at && (
            <DescriptionItem>
              <DescriptionTerm>{t("Accepted", "接受")}</DescriptionTerm>
              <DescriptionDetails>{dateTime(inv.accepted_at, locale)}</DescriptionDetails>
            </DescriptionItem>
          )}
          {inv.revoked_at && (
            <DescriptionItem>
              <DescriptionTerm>{t("Revoked", "撤销")}</DescriptionTerm>
              <DescriptionDetails>{dateTime(inv.revoked_at, locale)}</DescriptionDetails>
            </DescriptionItem>
          )}
          {inv.message && (
            <DescriptionItem>
              <DescriptionTerm>{t("Message", "附言")}</DescriptionTerm>
              <DescriptionDetails className="whitespace-pre-wrap">{inv.message}</DescriptionDetails>
            </DescriptionItem>
          )}
        </DescriptionList>
      </DetailSection>

      {actionable && (
        <DetailSection title={t("Danger zone", "危险操作")}>
          <ListRowGroup>
            <ListRow variant="plain" tone="danger" onClick={() => setRevoking(true)} disabled={revoke.isPending}>
              <ListRowIcon><Trash2 /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{t("Revoke invite", "撤销邀请")}</ListRowTitle>
                <ListRowDescription wrap>{t("The link stops working. This can't be undone.", "链接将失效。此操作无法撤回。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          </ListRowGroup>
        </DetailSection>
      )}

      <ConfirmActionDialog
        open={revoking}
        title={t("Revoke this invite?", "撤销此邀请？")}
        objectLabel={inv.email}
        objectHint={roleLabel(inv.role, t)}
        body={t(
          "Opening the link shows that it was revoked. This can't be undone; send a new invite to ask them again.",
          "打开链接会看到邀请已撤销。此操作无法撤回；如需再次邀请，请新建邀请。",
        )}
        confirmLabel={t("Revoke invite", "撤销邀请")}
        confirmKind="danger"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(undefined, { onSettled: () => setRevoking(false) })}
        onCancel={() => setRevoking(false)}
      />
    </DetailColumn>
  );
}

function CreateInviteDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ email: string; url: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      createOrgInvite(orgId, {
        email: email.trim().toLowerCase(),
        role,
        message: message.trim() ? message.trim() : null,
      }),
    onSuccess: (data) => {
      // Put the link on the clipboard for the admin to share; it is also shown.
      copy(data.invite_url);
      setCreated({ email: data.email ?? email.trim().toLowerCase(), url: data.invite_url });
      void qc.invalidateQueries({ queryKey: ["org-invites", orgId] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Invite failed", "邀请失败"), description: errorMessage(e) }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("Invite link ready", "邀请链接已就绪")}</DialogTitle>
              <DialogClose />
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <DialogDescription>
                {t(`Send this link to ${created.email}. It is on your clipboard and works for 7 days; Hands won't show it again.`, `把链接发送给 ${created.email}。链接已复制到剪贴板，7 天内有效；之后不会再显示。`)}
              </DialogDescription>
              <InviteLink url={created.url} />
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={onClose}>{t("Done", "完成")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("New invite", "新建邀请")}</DialogTitle>
              <DialogClose />
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <DialogDescription>
                {t("Hands makes a link for one person to join this organization.", "Hands 会生成一个链接，供一人加入此组织。")}
              </DialogDescription>
              <form
                id="create-invite-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
                className="flex flex-col gap-4"
              >
                <Field>
                  <FieldLabel>{t("Email", "邮箱")}</FieldLabel>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </Field>
                <Field>
                  <FieldLabel>{t("Role", "角色")}</FieldLabel>
                  <RadioGroup value={role} onValueChange={(v) => setRole(v as "member" | "viewer")} aria-label={t("Role", "角色")}>
                    <label className="flex items-start gap-2">
                      <RadioGroupItem value="member" aria-label={t("Member", "成员")} />
                      <span className="flex flex-col">
                        <span className="text-sm text-foreground-strong">{t("Member", "成员")}</span>
                        <span className="text-footnote text-foreground-muted">{t("Works on the organization's apps", "使用组织内的应用")}</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <RadioGroupItem value="viewer" aria-label={t("Viewer", "查看者")} />
                      <span className="flex flex-col">
                        <span className="text-sm text-foreground-strong">{t("Viewer", "查看者")}</span>
                        <span className="text-footnote text-foreground-muted">{t("Reads, changes nothing", "只读，不能修改")}</span>
                      </span>
                    </label>
                  </RadioGroup>
                </Field>
                <Field>
                  <FieldLabel>{t("Message", "附言")}</FieldLabel>
                  <Textarea className="min-h-16" value={message} onChange={(e) => setMessage(e.target.value)} />
                  <FieldDescription>{t("Optional. Shown on the invite page.", "可选，显示在邀请页面上。")}</FieldDescription>
                </Field>
              </form>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>{t("Cancel", "取消")}</Button>
              <Button
                type="submit"
                form="create-invite-form"
                variant="primary"
                loading={create.isPending}
                disabled={create.isPending || !email.trim()}
              >
                {t("Create link", "创建链接")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
