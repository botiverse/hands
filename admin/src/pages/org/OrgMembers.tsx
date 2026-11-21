/**
 * Organization › Members: a page of a list (design: patterns/page-structure).
 * The toolbar searches the members and narrows them to people or agents.
 * Each member is a row with their role at its end; opening one shows a column
 * beside the list with the role (a select that applies at once, for owners
 * and admins), the details, and removing them, which a dialog confirms.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Info, Search, UserMinus, Users, X, Crown } from "lucide-react";
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
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  ListRowValue,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectList,
  SelectTrigger,
  SelectValue,
  Text,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { listOrgMembers, removeOrgMember, transferOrgOwnership, updateOrgMember, type OrgMember } from "../../lib/api";
import { errorMessage } from "../../lib/errorMessage";
import { collidingPrincipalLabels, needsServerBadge, principalServer } from "../../lib/principalIdentity";
import { useLocale, useText } from "../../lib/locale";
import { useToast } from "../../components/Toast";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { DetailColumn, DetailSection } from "../../components/ListPage";
import { FilterSelect } from "../AuditLog";
import { OrgPage, day, roleLabel, type OrgFrame, type T } from "./OrgPage";

type Role = OrgMember["org_role"];
type Principal = "all" | "human" | "agent";

const handle = (m: OrgMember) => (m.username ? `@${m.username}` : `${m.provider_subject.slice(0, 16)}…`);

/** The roles the current person may give: admins up to admin, owners any. */
function assignableRoles(currentRole: string | null): Role[] {
  return currentRole === "owner" ? ["owner", "admin", "member", "viewer"] : ["admin", "member", "viewer"];
}

/** Whether the current person may change this member's role: owners and
 *  admins, not their own, and only an owner touches an owner. */
function canChangeRole(m: OrgMember, currentAccountId: string | null, currentRole: string | null) {
  const isAdmin = currentRole === "owner" || currentRole === "admin";
  return isAdmin && m.account_id !== currentAccountId && (currentRole === "owner" || m.org_role !== "owner");
}

function roleHint(role: Role, t: T) {
  switch (role) {
    case "owner": return t("Everything, including other owners", "全部权限，包括管理其他所有者");
    case "admin": return t("Manages members, invites, webhooks and signing", "管理成员、邀请、Webhook 和签名");
    case "member": return t("Works on the organization's apps", "使用组织内的应用");
    default: return t("Reads, changes nothing", "只读，不能修改");
  }
}

export function OrgMembers({
  frame,
  currentAccountId,
  currentRole,
}: {
  frame: OrgFrame;
  currentAccountId: string | null;
  currentRole: string | null;
}) {
  const t = useText();
  const { orgId } = frame;
  const isAdmin = currentRole === "admin" || currentRole === "owner";
  const [principalFilter, setPrincipalFilter] = useState<Principal>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const members = useQuery({ queryKey: ["org-members", orgId], queryFn: () => listOrgMembers(orgId) });
  const all = members.data?.members ?? [];
  const byType = all.filter((m) => principalFilter === "all" || m.principal_type === principalFilter);
  // Computed over the whole filtered collection, never per row: a row cannot
  // see its peers (see lib/principalIdentity.ts).
  const collidingLabels = useMemo(() => collidingPrincipalLabels(byType), [byType]);
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? byType.filter((m) => [m.display_name, m.username ?? "", m.server_slug ?? ""].some((s) => s.toLowerCase().includes(needle)))
    : byType;
  const filtering = principalFilter !== "all" || Boolean(needle);
  const open = all.find((m) => m.account_id === openId) ?? null;

  return (
    <OrgPage
      frame={frame}
      count={members.data ? rows.length : undefined}
      busy={members.isLoading}
      toolbar={
        <>
          <InputGroup className="w-auto min-w-48 flex-1 max-sm:basis-full sm:max-w-72">
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput
              aria-label={t("Search members", "搜索成员")}
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
          <FilterSelect
            label={t("Type", "类型")}
            items={{ all: t("Everyone", "所有人"), human: t("People", "用户"), agent: t("Agents", "智能体") }}
            value={principalFilter}
            onChange={(v) => setPrincipalFilter((v || "all") as Principal)}
          />
        </>
      }
      detail={
        open && (
          <MemberColumn
            key={open.account_id}
            orgId={orgId}
            member={open}
            currentAccountId={currentAccountId}
            currentRole={currentRole}
            serverSlug={principalServer(open) ?? null}
            onClose={() => setOpenId(null)}
            onRemoved={() => setOpenId(null)}
          />
        )
      }
    >
      {!isAdmin && currentRole && (
        <div className="px-(--column-margin)">
          <Banner status="info">
            <Info aria-hidden="true" />
            <BannerDescription>
              {t(`You are ${roleText(currentRole, t)} here: you can see the members, and an owner or admin changes them.`, `你在此组织中是${roleText(currentRole, t)}：可以查看成员，修改需要所有者或管理员。`)}
            </BannerDescription>
          </Banner>
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {members.isLoading && [0, 1, 2, 3].map((n) => <ListRowSkeleton key={n} cell leading />)}
        {members.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load the members", "无法加载成员")}</BannerTitle>
              <BannerDescription>{errorMessage(members.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void members.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}
        {members.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><Users aria-hidden="true" /></EmptyStateIcon>
              {filtering ? (
                <>
                  <EmptyStateTitle>{t("No members match", "没有符合条件的成员")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Change the search or the type.", "修改搜索或类型。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{t("No members yet", "还没有成员")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("People join by signing in with Raft or through an invite.", "成员通过 Raft 登录或邀请链接加入。")}</EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}
        {rows.map((m) => (
          <MemberRow
            key={m.account_id}
            member={m}
            you={m.account_id === currentAccountId}
            serverSlug={needsServerBadge(m, collidingLabels) ? (principalServer(m) ?? null) : null}
            selected={openId === m.account_id}
            onOpen={() => setOpenId(m.account_id)}
          />
        ))}
      </div>
    </OrgPage>
  );
}

const roleText = (role: string, t: T) => roleLabel(role, t).toLowerCase();

function MemberAvatar({ member, size }: { member: OrgMember; size: "sm" | "lg" }) {
  return (
    <Avatar size={size} type={member.principal_type === "agent" ? "agent" : "human"}>
      {member.avatar_url ? <AvatarImage src={member.avatar_url} alt="" /> : null}
      <AvatarFallback>{member.display_name.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function MemberRow({
  member: m,
  you,
  serverSlug,
  selected,
  onOpen,
}: {
  member: OrgMember;
  you: boolean;
  serverSlug: string | null;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <MemberAvatar member={m} size="sm" />
      <ListRowBody>
        <ListRowTop>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ListRowTitle className="flex-initial">
              {m.display_name}
              {you && <span className="ml-1 font-normal text-foreground-muted">{t("(you)", "（你）")}</span>}
            </ListRowTitle>
            {m.principal_type === "agent" && <Badge appearance="outline" className="shrink-0">{t("agent", "智能体")}</Badge>}
            {serverSlug && <Badge appearance="outline" className="shrink-0 font-mono">{serverSlug}</Badge>}
          </span>
        </ListRowTop>
        <ListRowSubtitle>
          <span className="font-mono">{handle(m)}</span>
          {" · "}
          {t(`joined ${day(m.joined_at, locale)}`, `${day(m.joined_at, locale)} 加入`)}
        </ListRowSubtitle>
      </ListRowBody>
      <ListRowValue>{roleLabel(m.org_role, t)}</ListRowValue>
    </ListRow>
  );
}

function MemberColumn({
  orgId,
  member: m,
  currentAccountId,
  currentRole,
  serverSlug,
  onClose,
  onRemoved,
}: {
  orgId: string;
  member: OrgMember;
  currentAccountId: string | null;
  currentRole: string | null;
  serverSlug: string | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const isAdmin = currentRole === "admin" || currentRole === "owner";
  const you = m.account_id === currentAccountId;
  const editable = canChangeRole(m, currentAccountId, currentRole);
  const removable = isAdmin && !you;
  const transferable = currentRole === "owner" && !you && m.org_role !== "owner";
  const roles = assignableRoles(currentRole);

  const update = useMutation({
    mutationFn: (role: Role) => updateOrgMember(orgId, m.account_id, role),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Member role updated", "成员角色已更新") });
      void qc.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Update failed", "更新失败"), description: errorMessage(e) }),
  });
  const transfer = useMutation({
    mutationFn: () => transferOrgOwnership(orgId, m.account_id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t(`${m.display_name} now owns the organization`, `${m.display_name} 现在是组织所有者`) });
      void qc.invalidateQueries({ queryKey: ["org-members", orgId] });
      void qc.invalidateQueries({ queryKey: ["orgs"] });
      void qc.invalidateQueries({ queryKey: ["auth-me"] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Transfer failed", "转移失败"), description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => removeOrgMember(orgId, m.account_id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Member removed", "成员已移除") });
      void qc.invalidateQueries({ queryKey: ["org-members", orgId] });
      onRemoved();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: errorMessage(e) }),
  });

  const why = you
    ? t("You can't change your own role.", "不能修改自己的角色。")
    : !isAdmin
      ? t("Only owners and admins change roles.", "只有所有者和管理员可以修改角色。")
      : t("Only an owner changes an owner's role.", "只有所有者可以修改所有者的角色。");

  return (
    <DetailColumn
      label={m.display_name}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <MemberAvatar member={m} size="sm" />
          <span className="min-w-0 truncate">{m.display_name}</span>
        </span>
      }
      meta={<span className="font-mono">{handle(m)}</span>}
      onClose={onClose}
    >
      <DetailSection title={t("Role", "角色")}>
        <ListRowGroup>
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="member-role-title">{t("Organization role", "组织角色")}</ListRowTitle>
              <ListRowDescription wrap>{editable ? roleHint(m.org_role, t) : why}</ListRowDescription>
            </ListRowBody>
            {!editable && <ListRowValue>{roleLabel(m.org_role, t)}</ListRowValue>}
            {editable && (
              <Select
                items={Object.fromEntries(roles.map((r) => [r, roleLabel(r, t)]))}
                value={m.org_role}
                onValueChange={(v) => { if (v && v !== m.org_role) update.mutate(v as Role); }}
                disabled={update.isPending}
              >
                <SelectTrigger className="w-32 shrink-0" aria-label={t(`Role of ${m.display_name}`, `${m.display_name} 的角色`)}>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>{roleLabel(r, t)}</SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            )}
          </ListRow>
        </ListRowGroup>
      </DetailSection>

      <DetailSection title={t("Details", "详情")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{t("Type", "类型")}</DescriptionTerm>
            <DescriptionDetails>{m.principal_type === "agent" ? t("Agent", "智能体") : t("Person", "用户")}</DescriptionDetails>
          </DescriptionItem>
          {serverSlug && (
            <DescriptionItem>
              <DescriptionTerm>{t("Raft server", "Raft 服务器")}</DescriptionTerm>
              <DescriptionDetails className="font-mono">{serverSlug}</DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem>
            <DescriptionTerm>{t("Server role", "服务器角色")}</DescriptionTerm>
            <DescriptionDetails>{m.server_role ? roleLabel(m.server_role, t) : "—"}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Joined", "加入")}</DescriptionTerm>
            <DescriptionDetails>{day(m.joined_at, locale)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Last sign-in", "上次登录")}</DescriptionTerm>
            <DescriptionDetails>{m.last_login_at ? day(m.last_login_at, locale) : t("Never", "从未")}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Account", "账号")}</DescriptionTerm>
            <DescriptionDetails className="font-mono [overflow-wrap:anywhere]">{m.account_id}</DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </DetailSection>

      {removable && (
        <DetailSection title={t("Danger zone", "危险操作")}>
          <ListRowGroup>
            {transferable && (
              <ListRow variant="plain" onClick={() => setTransferring(true)} disabled={transfer.isPending}>
                <ListRowIcon><Crown /></ListRowIcon>
                <ListRowBody>
                  <ListRowTitle>{t("Transfer ownership", "转移所有权")}</ListRowTitle>
                  <ListRowDescription wrap>
                    {t("They become owner and you become admin.", "对方成为所有者，你变为管理员。")}
                  </ListRowDescription>
                </ListRowBody>
              </ListRow>
            )}
            <ListRow variant="plain" onClick={() => setRemoving(true)} disabled={remove.isPending}>
              <ListRowIcon><UserMinus /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{t("Remove from organization", "从组织中移除")}</ListRowTitle>
                <ListRowDescription wrap>
                  {t("They lose access to every app in this organization.", "对方将失去此组织所有应用的访问权限。")}
                </ListRowDescription>
              </ListRowBody>
            </ListRow>
          </ListRowGroup>
        </DetailSection>
      )}
      {!isAdmin && (
        <Text.Sans size="small" variant="muted">{t("Owners and admins manage members.", "所有者和管理员可以管理成员。")}</Text.Sans>
      )}

      <ConfirmActionDialog
        open={transferring}
        title={t("Transfer ownership?", "转移所有权？")}
        objectLabel={m.display_name}
        objectHint={handle(m)}
        body={t(
          "They become an owner of this organization and you become an admin. Only an owner can make you owner again.",
          "对方成为此组织的所有者，你变为管理员。之后只有所有者能把你改回所有者。",
        )}
        confirmLabel={t("Transfer ownership", "转移所有权")}
        confirmKind="warning"
        pending={transfer.isPending}
        onConfirm={() => transfer.mutate(undefined, { onSettled: () => setTransferring(false) })}
        onCancel={() => setTransferring(false)}
      />
      <ConfirmActionDialog
        open={removing}
        title={t("Remove this member?", "移除此成员？")}
        objectLabel={m.display_name}
        objectHint={handle(m)}
        body={t(
          "They lose access to this organization and its apps at once. You can invite them again.",
          "对方将立即失去此组织及其应用的访问权限。之后可以再次邀请。",
        )}
        confirmLabel={t("Remove", "移除")}
        confirmKind="warning"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSettled: () => setRemoving(false) })}
        onCancel={() => setRemoving(false)}
      />
    </DetailColumn>
  );
}
