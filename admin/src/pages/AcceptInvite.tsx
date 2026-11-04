/**
 * AcceptInvite — public magic-link landing page.
 *
 * URL: /invites/:token
 * If not signed in, "Sign in with Raft to accept" button.
 * After accept: redirect to /apps/:appId or / (org dashboard).
 *
 * Wires the new P5.3 endpoints:
 *   GET /api/invites/:token  (public — view invite details)
 *   POST /api/invites/:token/accept  (auth required — accept invite)
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { acceptInvite, getAuthMe, loginUrl, type Invite } from "../lib/api";
import { useToast } from "../components/Toast";
import { Button } from "raft-ui";
import { LanguagePicker, useLocale, useText } from "../lib/locale";

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
          throw new Error(body || `invite fetch failed ${res.status}`);
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
        description: (e as Error).message,
      }),
  });

  if (loading) {
    return (
      <div className="max-w-md mx-auto mt-20 p-4 text-center text-foreground-muted">
        <LanguagePicker /> <p>{t("Loading invite…", "正在加载邀请…")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-20 p-4">
        <LanguagePicker />
        <div className="rounded-md bg-danger-soft p-4 text-sm text-danger-strong">
          <strong>{t("Invite error:", "邀请出错：")}</strong> {error}
        </div>
      </div>
    );
  }

  if (!invite) return null;

  const isExpired = invite.expires_at < Date.now();
  const isAccepted = invite.status === "accepted";
  const isRevoked = invite.status === "revoked";
  const roleZh: Record<string, string> = { owner: "所有者", admin: "管理员", publisher: "发布者", developer: "开发者", viewer: "查看者", member: "成员" };
  const role = t(invite.role, roleZh[invite.role] ?? invite.role);

  return (
    <div className="max-w-md mx-auto mt-20 p-4">
      <LanguagePicker />
      <div>
        <h1 className="text-xl font-bold mb-2">{t("You've been invited", "您收到一份邀请")}</h1>
        <p className="text-sm text-foreground mb-4">
          {locale === "zh-CN" ? <>
            <strong>{invite.invited_by_display_name ?? "有人"}</strong> 邀请您以 <strong>{role}</strong> 身份加入 <strong>{invite.org_name ?? invite.org_id}</strong>
            {invite.app_name && <>，并访问 <strong>{invite.app_name}</strong></>}。
          </> : <>
          <strong>{invite.invited_by_display_name ?? "Someone"}</strong> invited you to join <strong>{invite.org_name ?? invite.org_id}</strong>
          {invite.app_name ? (
            <>
              {" "}with access to <strong>{invite.app_name}</strong> as{" "}
              <strong>{role}</strong>
            </>
          ) : (
            <>
              {" "}as <strong>{role}</strong>
            </>
          )}
          .</>}
        </p>

        {invite.message && (
          <blockquote className="border-l-2 border-line-muted pl-3 my-4 text-sm text-foreground italic">
            {invite.message}
          </blockquote>
        )}

        {isExpired && (
          <p className="text-sm text-danger my-4">
            {t(`This invite expired on ${new Date(invite.expires_at).toISOString().slice(0, 16)}Z. Ask the inviter to create a new link.`, `此邀请已于 ${new Date(invite.expires_at).toISOString().slice(0, 16)}Z 过期，请邀请人创建新链接。`)}
          </p>
        )}
        {isAccepted && (
          <p className="text-sm text-success-strong my-4">
            {t("✓ You've already accepted this invite.", "✓ 您已接受此邀请。")}
          </p>
        )}
        {isRevoked && (
          <p className="text-sm text-danger my-4">
            {t("This invite was revoked by the inviter.", "邀请人已撤销此邀请。")}
          </p>
        )}

        {!me.data?.authenticated && !isExpired && !isAccepted && !isRevoked && (
          <Button
            variant="primary"
            className="block text-center mt-4"
            render={<a href={loginUrl(`/invites/${token}`)} />}
          >
            {t("Sign in with Raft to accept", "使用 Raft 登录以接受邀请")}
          </Button>
        )}

        {me.data?.authenticated &&
          !isExpired &&
          !isAccepted &&
          !isRevoked && (
            <Button
              variant="primary"
              className="w-full mt-4"
              onClick={() => accept.mutate()}
              disabled={accept.isPending}
            >
              {accept.isPending ? t("Accepting…", "正在接受…") : t("Accept invite", "接受邀请")}
            </Button>
          )}

        <p className="text-xs text-foreground-hint mt-4">
          {t("Token:", "令牌：")} <code>{token.slice(0, 12)}…</code> · {t("Expires", "过期时间")}{" "}
          {new Date(invite.expires_at).toISOString().slice(0, 16)}Z
        </p>
      </div>
    </div>
  );
}
