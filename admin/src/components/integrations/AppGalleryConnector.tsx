import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Smartphone } from "lucide-react";
import {
  Badge,
  Button,
} from "raft-ui";
import {
  deleteAgcCredentials,
  getAgcCredentials,
  setAgcCredentials,
  verifyAgcCredentials,
} from "../../lib/api";
import { useToast } from "../Toast";
import { useText } from "../../lib/locale";

/**
 * AppGallery Connect connector row for the Integrations page. Moved out of
 * the app Settings section unchanged: same queries, mutations and form flow —
 * the row is collapsed until configured, then expandable.
 */
export function AppGalleryConnector({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["agc-credentials", appId],
    queryFn: () => getAgcCredentials(appId),
  });
  const meta = query.data?.agc_credentials ?? null;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [credentialJson, setCredentialJson] = useState("");
  const save = useMutation({
    mutationFn: () => setAgcCredentials(appId, credentialJson),
    onSuccess: () => {
      setCredentialJson("");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["agc-credentials", appId] });
      toast.show({ kind: "success", title: t("AppGallery Connect credential saved", "AppGallery Connect 凭据已保存") });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: (e as Error).message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAgcCredentials(appId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agc-credentials", appId] });
      toast.show({ kind: "success", title: t("AppGallery Connect credential removed", "AppGallery Connect 凭据已移除") });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: (e as Error).message }),
  });
  const test = useMutation({
    mutationFn: () => verifyAgcCredentials(appId),
    onSuccess: (r) =>
      toast.show(
        r.ok
          ? {
              kind: "success",
              title: t("Connection OK", "连接成功"),
              description: t(`${r.credential_kind === "service_account" ? "Service Account JWT signing" : "AGC token exchange"} succeeded; credential expires in ${Math.round((r.expires_in ?? 0) / 3600)} hours.`, `${r.credential_kind === "service_account" ? "服务账号 JWT 签名" : "AGC 令牌交换"}成功；凭据将在 ${Math.round((r.expires_in ?? 0) / 3600)} 小时后过期。`),
            }
          : { kind: "error", title: t("Verification failed", "验证失败"), description: r.error ?? t("Unknown AGC error", "未知 AGC 错误") },
      ),
    onError: (e) =>
      toast.show({ kind: "error", title: t("Test failed", "测试失败"), description: (e as Error).message }),
  });

  const form = (
    <div className="space-y-3">
      <label className="block text-xs font-medium">{t("AGC Service Account private JSON", "AGC 服务账号私钥 JSON")}</label>
      <Button variant="outline" size="xs" className="self-start" render={<label className="cursor-pointer" />}>
        {t("Choose JSON file", "选择 JSON 文件")}
        <input
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              file.text().then(setCredentialJson, () =>
                toast.show({ kind: "error", title: t("Could not read the credential file", "无法读取凭据文件") }),
              );
          }}
        />
      </Button>
      <div className="text-xs text-foreground-muted">
        {t("Select the private JSON downloaded from AppGallery Connect. Service Account is recommended; legacy API client JSON remains supported during migration.", "选择从 AppGallery Connect 下载的私钥 JSON。建议使用服务账号；迁移期间仍支持旧版 API 客户端 JSON。")}
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!credentialJson || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t("Saving…", "保存中…") : t("Save credential", "保存凭据")}
        </Button>
        {meta && (
          <Button
            variant="outline"
            onClick={() => {
              setCredentialJson("");
              setEditing(false);
            }}
          >
            {t("Cancel", "取消")}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <section data-testid="appgallery-connector" className="border-t border-line-hairline pt-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fill-muted text-foreground-muted">
          <Smartphone className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground-strong">AppGallery Connect</h3>
          <p className="mt-0.5 text-xs text-foreground-muted">
            {t("Service Account or legacy API client credential used for HarmonyOS testing and publishing. The uploaded JSON is encrypted and private material is never shown again.", "用于 HarmonyOS 测试和发布的服务账号或旧版 API 客户端凭据。上传的 JSON 会加密，私密内容不会再次显示。")}
          </p>
        {meta ? (
          <div className="mt-1.5 space-y-0.5 text-xs text-foreground-muted">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant="success">{t("Configured", "已配置")}</Badge>
              <span>{t(meta.credential_kind, meta.credential_kind === "service_account" ? "服务账号" : "旧版 API 客户端")}</span>
              <span>{t(`updated ${new Date(meta.updated_at).toISOString().slice(0, 10)}`, `更新于 ${new Date(meta.updated_at).toISOString().slice(0, 10)}`)}</span>
            </div>
            {meta.credential_kind === "service_account" ? (
              <div className="font-mono break-all">
                {t(`Sub-account ${meta.sub_account} · Key ${meta.key_id} · Project ${meta.project_id || "default"}`, `子账号 ${meta.sub_account} · 密钥 ${meta.key_id} · 项目 ${meta.project_id || "默认"}`)}
              </div>
            ) : (
              <div className="font-mono break-all">
                {t(`Developer ${meta.developer_id} · Project ${meta.project_id} · Client ${meta.client_id}`, `开发者 ${meta.developer_id} · 项目 ${meta.project_id} · 客户端 ${meta.client_id}`)}
              </div>
            )}
            <div className="font-mono">
              {t(`Region ${meta.region || "default"} · Fingerprint ${meta.credential_fingerprint.slice(0, 12)}…`, `区域 ${meta.region || "默认"} · 指纹 ${meta.credential_fingerprint.slice(0, 12)}…`)}
            </div>
          </div>
        ) : null}
        </div>
        <div className="flex items-center gap-2">
          {meta ? (
            <Button
              variant="outline"
              size="icon-sm"
              aria-expanded={expanded}
              aria-label={expanded ? t("Collapse", "收起") : t("Expand", "展开")}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown
                className={`size-4 transition-transform${expanded ? " rotate-180" : ""}`}
                aria-hidden="true"
              />
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={query.isLoading}
              onClick={() => setExpanded(true)}
            >
              {t("Configure", "配置")}
            </Button>
          )}
        </div>
      </div>
      {meta && expanded ? (
        <div className="mt-3 space-y-3 border-t border-line-hairline pt-4">
          {!editing && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? t("Testing…", "测试中…") : t("Test connection", "测试连接")}
              </Button>
              <Button variant="outline" onClick={() => setEditing(true)}>
                {t("Replace credential", "更换凭据")}
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      t("Remove the AppGallery Connect credential? Publishing stops until a new credential is saved.", "移除 AppGallery Connect 凭据？在保存新凭据之前将无法发布。"),
                    )
                  ) {
                    remove.mutate();
                  }
                }}
              >
                {remove.isPending ? "…" : t("Remove", "移除")}
              </Button>
            </div>
          )}
          {editing ? form : null}
        </div>
      ) : null}
      {!meta && expanded ? (
        <div className="mt-3 border-t border-line-hairline pt-4">{form}</div>
      ) : null}
    </section>
  );
}
