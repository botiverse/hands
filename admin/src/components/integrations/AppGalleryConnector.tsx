import { errorMessage } from "../../lib/errorMessage";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  ListRowGroup,
  Text,
} from "@botiverse/raft-ui";
import {
  deleteAgcCredentials,
  getAgcCredentials,
  setAgcCredentials,
  verifyAgcCredentials,
} from "../../lib/api";
import { useToast } from "../Toast";
import { useLocale, useText } from "../../lib/locale";
import { DetailSection } from "../ListPage";
import { DangerRow, FormActions, SettingRow, type ConnectorState } from "./ConnectorParts";

/** The state of an app's AppGallery Connect credential, for its row in the list. */
export function useAppGalleryState(appId: string, enabled = true): ConnectorState | undefined {
  const t = useText();
  const query = useQuery({ queryKey: ["agc-credentials", appId], queryFn: () => getAgcCredentials(appId), enabled });
  if (!query.data) return undefined;
  const meta = query.data.agc_credentials;
  return meta
    ? { tone: "connected", label: t("Connected", "已连接"), detail: (meta.credential_kind === "service_account" ? meta.sub_account : meta.client_id) ?? undefined }
    : { tone: "off", label: t("Not connected", "未连接") };
}

/**
 * AppGallery Connect connector: the column the Integrations page opens
 * beside its list. Without a credential it shows the file form; with one,
 * its details, Test connection, Replace credential and Remove credential.
 */
export function AppGalleryConnector({ appId }: { appId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["agc-credentials", appId],
    queryFn: () => getAgcCredentials(appId),
  });
  const meta = query.data?.agc_credentials ?? null;
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
      toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAgcCredentials(appId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agc-credentials", appId] });
      toast.show({ kind: "success", title: t("AppGallery Connect credential removed", "AppGallery Connect 凭据已移除") });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: errorMessage(e) }),
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
      toast.show({ kind: "error", title: t("Test failed", "测试失败"), description: errorMessage(e) }),
  });

  const [fileName, setFileName] = useState("");
  const form = (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={`agc-file-${appId}`}>{t("AGC Service Account private JSON", "AGC 服务账号私钥 JSON")}</FieldLabel>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" render={<label className="cursor-pointer" />} nativeButton={false}>
            {t("Choose JSON file", "选择 JSON 文件")}
            <input
              id={`agc-file-${appId}`}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setFileName(file.name);
                  file.text().then(setCredentialJson, () =>
                    toast.show({ kind: "error", title: t("Could not read the credential file", "无法读取凭据文件") }),
                  );
                }
              }}
            />
          </Button>
          {credentialJson && fileName && <span className="min-w-0 truncate font-mono text-footnote text-foreground-muted">{fileName}</span>}
        </div>
        <FieldDescription>
          {t("Select the private JSON downloaded from AppGallery Connect. Service Account is recommended; legacy API client JSON remains supported during migration.", "选择从 AppGallery Connect 下载的私钥 JSON。建议使用服务账号；迁移期间仍支持旧版 API 客户端 JSON。")}
        </FieldDescription>
      </Field>
      <FormActions>
        <Button variant="primary" disabled={!credentialJson || save.isPending} onClick={() => save.mutate()}>
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
      </FormActions>
    </div>
  );

  const updated = meta ? new Date(meta.updated_at).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" }) : "";

  return (
    <div data-testid="appgallery-connector" className="flex flex-col gap-6">
      <Text.Sans size="small" variant="muted">
        {t("Service Account or legacy API client credential used for HarmonyOS testing and publishing. The uploaded JSON is encrypted and private material is never shown again.", "用于 HarmonyOS 测试和发布的服务账号或旧版 API 客户端凭据。上传的 JSON 会加密，私密内容不会再次显示。")}
      </Text.Sans>

      {!meta && !query.isLoading && <DetailSection title={t("Add a credential", "添加凭据")}>{form}</DetailSection>}

      {meta && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge appearance="soft" variant="success">{t("Configured", "已配置")}</Badge>
          </div>
          <DetailSection title={t("Credential", "凭据")}>
            <ListRowGroup>
              <SettingRow
                title={meta.credential_kind === "service_account" ? t("Service account", "服务账号") : t("Legacy API client", "旧版 API 客户端")}
                description={<span className="font-mono [overflow-wrap:anywhere]">
                  {meta.credential_kind === "service_account"
                    ? t(`Sub-account ${meta.sub_account} · Key ${meta.key_id} · Project ${meta.project_id || "default"}`, `子账号 ${meta.sub_account} · 密钥 ${meta.key_id} · 项目 ${meta.project_id || "默认"}`)
                    : t(`Developer ${meta.developer_id} · Project ${meta.project_id} · Client ${meta.client_id}`, `开发者 ${meta.developer_id} · 项目 ${meta.project_id} · 客户端 ${meta.client_id}`)}
                </span>}
              />
              <SettingRow
                title={t("Region and fingerprint", "区域和指纹")}
                description={<span className="font-mono">{t(`Region ${meta.region || "default"} · Fingerprint ${meta.credential_fingerprint.slice(0, 12)}…`, `区域 ${meta.region || "默认"} · 指纹 ${meta.credential_fingerprint.slice(0, 12)}…`)}</span>}
              />
              <SettingRow title={t("Updated", "更新时间")} description={updated} />
            </ListRowGroup>
          </DetailSection>
          {editing ? (
            <DetailSection title={t("Replace credential", "更换凭据")}>{form}</DetailSection>
          ) : (
            <DetailSection title={t("Actions", "操作")}>
              <ListRowGroup>
                <SettingRow
                  title={t("Check the credential", "检查凭据")}
                  description={t("Signs in to AppGallery Connect with it and reports how long the token lasts.", "用它登录 AppGallery Connect，并显示令牌的有效期。")}
                >
                  <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                    {test.isPending ? t("Testing…", "测试中…") : t("Test connection", "测试连接")}
                  </Button>
                </SettingRow>
                <SettingRow
                  title={t("New credential", "新凭据")}
                  description={t("Save another JSON file in place of this one.", "用另一个 JSON 文件替换这个。")}
                >
                  <Button variant="outline" onClick={() => setEditing(true)}>{t("Replace credential", "更换凭据")}</Button>
                </SettingRow>
              </ListRowGroup>
            </DetailSection>
          )}
          <DetailSection title={t("Danger zone", "危险操作")}>
            <DangerRow
              title={t("Remove credential", "移除凭据")}
              description={t("Publishing to AppGallery stops until a new credential is saved.", "在保存新凭据之前，将无法发布到 AppGallery。")}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t("Remove the AppGallery Connect credential? Publishing stops until a new credential is saved.", "移除 AppGallery Connect 凭据？在保存新凭据之前将无法发布。"))) {
                  remove.mutate();
                }
              }}
            />
          </DetailSection>
        </>
      )}
    </div>
  );
}
