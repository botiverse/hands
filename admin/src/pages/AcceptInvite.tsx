/**
 * AcceptInvite — the page an invite link opens (/invites/:token).
 *
 * One card in the middle of the page: who invited you to which organization
 * (and app) as what, their message, and one primary action: Accept, or Sign
 * in with Raft first. An invite that was accepted, revoked or has expired
 * says so instead of offering the action. After accepting, the console opens
 * the app (/apps/:appId) or the organization's apps.
 *
 *   GET /api/invites/:token          (public — the invite's details)
 *   POST /api/invites/:token/accept  (signed in — accept it)
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, CircleX, Clock, MailOpen, Unlink } from "lucide-react";
import {
  Banner,
  BannerDescription,
  BannerTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardLeading,
  CardTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Skeleton,
} from "@botiverse/raft-ui";
import { acceptInvite, getAuthMe, loginUrl, type Invite } from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useToast } from "../components/Toast";
import { useLocale, useText } from "../lib/locale";
import { dateTime, roleLabel } from "./org/OrgPage";

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-full flex-1 items-center justify-center px-4 py-10">{children}</main>;
}

export function AcceptInvite({ token }: { token: string }) {
  const t = useText();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const toast = useToast();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch invite details on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/invites/${token}`);
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.text();
          let reason = body;
          try {
            const parsed = JSON.parse(body) as { error?: unknown };
            if (typeof parsed.error === "string") reason = parsed.error;
          } catch {
            // Not JSON: show the body as it is.
          }
          throw new Error(reason || `invite fetch failed ${res.status}`);
        }
        const data = (await res.json()) as Invite;
        setInvite(data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = useMutation({
    mutationFn: () => acceptInvite(token),
    onSuccess: (data) => {
      toast.show({ kind: "success", title: t("Invite accepted", "已接受邀请") });
      navigate(data.app_id ? `/apps/${data.app_id}` : "/");
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Accept failed", "接受邀请失败"),
        description: errorMessage(e),
      }),
  });

  if (loading) {
    return (
      <Frame>
        <Card className="w-full max-w-md" aria-busy="true" aria-label={t("Loading invite…", "正在加载邀请…")}>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </Frame>
    );
  }

  if (error || !invite) {
    return (
      <Frame>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardLeading><Unlink aria-hidden="true" /></CardLeading>
            <CardTitle render={<h1 />}>{t("This invite can't be opened", "无法打开此邀请")}</CardTitle>
            <CardDescription>{t("The link may be mistyped, or replaced by a newer one. Ask the person who invited you for a new link.", "链接可能有误，或已被新链接取代。请联系邀请人获取新链接。")}</CardDescription>
          </CardHeader>
          {error && <CardFooter className="font-mono [overflow-wrap:anywhere]">{errorMessage(error)}</CardFooter>}
        </Card>
      </Frame>
    );
  }

  const isExpired = invite.status === "expired" || (invite.status === "pending" && invite.expires_at < Date.now());
  const isAccepted = invite.status === "accepted";
  const isRevoked = invite.status === "revoked";
  const open = !isExpired && !isAccepted && !isRevoked;
  const role = roleLabel(invite.role, t);
  const orgName = invite.org_name ?? invite.org_id;
  const inviter = invite.invited_by_display_name ?? t("Someone", "有人");
  const expires = dateTime(invite.expires_at, locale);

  return (
    <Frame>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardLeading><MailOpen aria-hidden="true" /></CardLeading>
          <CardTitle render={<h1 />}>{t(`Join ${orgName}`, `加入 ${orgName}`)}</CardTitle>
          <CardDescription>
            {invite.app_name
              ? t(`${inviter} invited you to ${invite.app_name} as ${role.toLowerCase()}.`, `${inviter} 邀请你以${role}身份访问 ${invite.app_name}。`)
              : t(`${inviter} invited you as ${role.toLowerCase()}.`, `${inviter} 邀请你以${role}身份加入。`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {invite.message && (
            <blockquote className="border-l-2 border-line-muted pl-3 text-sm whitespace-pre-wrap text-foreground">
              {invite.message}
            </blockquote>
          )}

          <DescriptionList direction="horizontal">
            <DescriptionItem>
              <DescriptionTerm>{t("Organization", "组织")}</DescriptionTerm>
              <DescriptionDetails>{orgName}</DescriptionDetails>
            </DescriptionItem>
            {invite.app_name && (
              <DescriptionItem>
                <DescriptionTerm>{t("App", "应用")}</DescriptionTerm>
                <DescriptionDetails>{invite.app_name}</DescriptionDetails>
              </DescriptionItem>
            )}
            <DescriptionItem>
              <DescriptionTerm>{t("Role", "角色")}</DescriptionTerm>
              <DescriptionDetails>{role}</DescriptionDetails>
            </DescriptionItem>
            <DescriptionItem>
              <DescriptionTerm>{t("For", "收件人")}</DescriptionTerm>
              <DescriptionDetails className="[overflow-wrap:anywhere]">{invite.email}</DescriptionDetails>
            </DescriptionItem>
          </DescriptionList>

          {isExpired && (
            <Banner status="warning">
              <Clock aria-hidden="true" />
              <BannerTitle>{t("This invite has expired", "此邀请已过期")}</BannerTitle>
              <BannerDescription>{t(`It expired ${expires}. Ask ${inviter} for a new link.`, `已于 ${expires} 过期。请向 ${inviter} 索取新链接。`)}</BannerDescription>
            </Banner>
          )}
          {isAccepted && (
            <Banner status="success">
              <CheckCircle2 aria-hidden="true" />
              <BannerTitle>{t("You've already accepted this invite", "你已接受此邀请")}</BannerTitle>
            </Banner>
          )}
          {isRevoked && (
            <Banner status="destructive">
              <CircleX aria-hidden="true" />
              <BannerTitle>{t("This invite was revoked", "此邀请已撤销")}</BannerTitle>
              <BannerDescription>{t("The person who sent it took it back.", "邀请人已撤回此邀请。")}</BannerDescription>
            </Banner>
          )}

          {open && !me.data?.authenticated && (
            <Button variant="primary" size="xl" className="w-full" render={<a href={loginUrl(`/invites/${token}`)} />} nativeButton={false}>
              {t("Sign in with Raft to accept", "使用 Raft 登录以接受邀请")}
            </Button>
          )}
          {open && me.data?.authenticated && (
            <Button
              variant="primary"
              size="xl"
              className="w-full"
              onClick={() => accept.mutate()}
              loading={accept.isPending}
              disabled={accept.isPending}
            >
              {t("Accept invite", "接受邀请")}
            </Button>
          )}
          {isAccepted && (
            <Button variant="outline" size="xl" className="w-full" render={<Link to={invite.app_id ? `/apps/${invite.app_id}` : "/apps"} />} nativeButton={false}>
              {invite.app_id ? t("Open the app", "打开应用") : t("Open Hands", "打开 Hands")}
            </Button>
          )}
        </CardContent>
        {open && (
          <CardFooter>
            {t(`Expires ${expires}`, `${expires} 过期`)}
            {" · "}
            <span className="font-mono">{token.slice(0, 12)}…</span>
          </CardFooter>
        )}
      </Card>
    </Frame>
  );
}
