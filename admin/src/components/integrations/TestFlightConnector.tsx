import { errorMessage } from "../../lib/errorMessage";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRowGroup,
  Text,
  TextLink,
  TextLinkExternalIcon,
  Textarea,
} from "@botiverse/raft-ui";
import {
  deleteAscCredentials,
  getAscCredentials,
  setAscCredentials,
  verifyAscCredentials,
} from "../../lib/api";
import { useToast } from "../Toast";
import { useLocale, useText } from "../../lib/locale";
import { DetailSection } from "../ListPage";
import { DangerRow, FormActions, SettingRow, type ConnectorState } from "./ConnectorParts";

/** The state of an app's App Store Connect key, for its row in the list. */
export function useTestFlightState(appId: string, enabled = true): ConnectorState | undefined {
  const t = useText();
  const creds = useQuery({ queryKey: ["asc-credentials", appId], queryFn: () => getAscCredentials(appId), enabled });
  if (!creds.data) return undefined;
  const meta = creds.data.asc_credentials;
  return meta
    ? { tone: "connected", label: t("Connected", "已连接"), detail: `Key ID ${meta.key_id}` }
    : { tone: "off", label: t("Not connected", "未连接") };
}

/**
 * App Store Connect / TestFlight connector: the column the Integrations page
 * opens beside its list. Without a key it shows how to make one and the form;
 * with one, the key, Test connection, Replace key and Remove key.
 */
export function TestFlightConnector({ appId }: { appId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["asc-credentials", appId],
    queryFn: () => getAscCredentials(appId),
  });
  const meta = creds.data?.asc_credentials ?? null;
  const [editing, setEditing] = useState(false);
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [p8, setP8] = useState("");

  const save = useMutation({
    mutationFn: () =>
      setAscCredentials(appId, {
        key_id: keyId.trim(),
        issuer_id: issuerId.trim(),
        p8: p8.trim(),
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("TestFlight credentials saved", "TestFlight 凭据已保存") });
      setEditing(false);
      setKeyId("");
      setIssuerId("");
      setP8("");
      qc.invalidateQueries({ queryKey: ["asc-credentials", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAscCredentials(appId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("TestFlight credentials removed", "TestFlight 凭据已移除") });
      qc.invalidateQueries({ queryKey: ["asc-credentials", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: errorMessage(e) }),
  });

  const test = useMutation({
    mutationFn: () => {
      const bundleId = window.prompt(
        t("Bundle ID to verify against App Store Connect (e.g. build.raft.app):", "要在 App Store Connect 中验证的 Bundle ID（例如 build.raft.app）："),
        "",
      );
      if (!bundleId || !bundleId.trim()) throw new Error("cancelled");
      return verifyAscCredentials(appId, bundleId.trim());
    },
    onSuccess: (res) => {
      if (res.ok) {
        toast.show({
          kind: "success",
          title: t("Connection OK", "连接成功"),
          description: res.asc_app_id
            ? t(`App Store Connect app ${res.asc_app_id} found.`, `已找到 App Store Connect 应用 ${res.asc_app_id}。`)
            : res.detail ?? "",
        });
      } else {
        toast.show({
          kind: "error",
          title: t("Verification failed", "验证失败"),
          description: res.detail ?? res.error ?? t("unknown", "未知错误"),
        });
      }
    },
    onError: (e) => {
      if ((e as Error).message === "cancelled") return;
      toast.show({ kind: "error", title: t("Test failed", "测试失败"), description: errorMessage(e) });
    },
  });

  const readP8File = (file: File | undefined) => {
    if (!file) return;
    file.text().then(
      (text) => setP8(text),
      () => toast.show({ kind: "error", title: t("Could not read the .p8 file", "无法读取 .p8 文件") }),
    );
  };

  const formValid =
    keyId.trim().length > 0 && issuerId.trim().length > 0 && p8.includes("BEGIN") && p8.includes("KEY");
  const p8LooksWrong = p8.trim().length > 0 && !(p8.includes("BEGIN") && p8.includes("KEY"));
  const external = (href: string, label: string) => (
    <TextLink render={<a href={href} target="_blank" rel="noopener noreferrer" />} nativeButton={false}>
      {label}
      <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
    </TextLink>
  );

  const form = (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={`asc-key-${appId}`}>Key ID</FieldLabel>
        <Input id={`asc-key-${appId}`} className="font-mono" placeholder="ABC123DEFG" value={keyId} onChange={(e) => setKeyId(e.target.value)} aria-required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`asc-issuer-${appId}`}>Issuer ID</FieldLabel>
        <Input id={`asc-issuer-${appId}`} className="font-mono" placeholder="12345678-90ab-cdef-1234-567890abcdef" value={issuerId} onChange={(e) => setIssuerId(e.target.value)} aria-required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`asc-p8-${appId}`}>{t("Private key (.p8 contents)", "私钥（.p8 文件内容）")}</FieldLabel>
        <Textarea
          id={`asc-p8-${appId}`}
          className="h-28 w-full resize-y font-mono"
          placeholder={t("Paste the contents of the downloaded .p8 AuthKey file", "粘贴下载的 .p8 AuthKey 文件内容")}
          value={p8}
          onChange={(e) => setP8(e.target.value)}
          aria-required
        />
        <FieldDescription>
          {p8LooksWrong ? (
            <span className="text-warning-strong">
              {t("This does not look like a .p8 private key — paste the full PEM contents of the downloaded AuthKey file, including the header and footer lines.", "这不像是 .p8 私钥，请粘贴下载的 AuthKey 文件的完整 PEM 内容，包括开头和结尾行。")}
            </span>
          ) : t("The App Store Connect app record must match the bundle ID your IPAs are signed with.", "App Store Connect 的应用记录必须与 IPA 签名使用的 Bundle ID 一致。")}
        </FieldDescription>
      </Field>
      <div>
        <Button variant="outline" render={<label className="cursor-pointer" />} nativeButton={false}>
          {t("Load from .p8 file", "从 .p8 文件加载")}
          <input type="file" accept=".p8,.pem" className="hidden" onChange={(e) => readP8File(e.target.files?.[0])} />
        </Button>
      </div>
      <FormActions>
        <Button variant="primary" disabled={!formValid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "…" : meta ? t("Replace credentials", "更换凭据") : t("Save & enable", "保存并启用")}
        </Button>
        {editing && (
          <Button
            variant="outline"
            onClick={() => {
              setEditing(false);
              setKeyId("");
              setIssuerId("");
              setP8("");
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
    <div data-testid="testflight-connector" className="flex flex-col gap-6">
      <Text.Sans size="small" variant="muted">
        {t("App Store Connect API key used to upload builds of this app to TestFlight. Stored encrypted; the private key is never shown again after saving.", "用于将此应用构建上传到 TestFlight 的 App Store Connect API 密钥。密钥会加密保存；私钥保存后不会再次显示。")}
      </Text.Sans>

      {!meta && !creds.isLoading && (
        <>
          <DetailSection title={t("Make a key", "创建密钥")}>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-callout text-foreground marker:font-mono marker:text-foreground-muted">
              <li>
                {t("In ", "在 ")}{external("https://appstoreconnect.apple.com", "App Store Connect")}
                {t(" → Apps, create an app record for this bundle ID if there isn't one. TestFlight needs only the record, no store listing or review.", " → App 中，如果还没有此 Bundle ID 的应用记录，先创建一个。TestFlight 只需要记录，不需要商店页面或审核。")}
              </li>
              <li>
                {t("Open ", "打开 ")}{external("https://appstoreconnect.apple.com/access/integrations/api", t("Users and Access → Integrations → App Store Connect API", "用户和访问 → 集成 → App Store Connect API"))}
                {t(" and generate a Team Key with the App Manager role (needs an Admin account).", "，生成 App 管理员角色的团队密钥（需要管理员账号）。")}
              </li>
              <li>
                {t("Copy the Issuer ID at the top of that page and the key's Key ID, then download ", "复制页面顶部的 Issuer ID 和密钥的 Key ID，然后下载 ")}
                <span className="font-mono">AuthKey_XXXXXXXXXX.p8</span>
                {t(". Apple lets you download it only once.", "。Apple 只允许下载一次。")}
              </li>
            </ol>
          </DetailSection>
          <DetailSection title={t("Add the key", "添加密钥")}>{form}</DetailSection>
        </>
      )}

      {meta && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge appearance="soft" variant="success">{t("Configured", "已配置")}</Badge>
          </div>
          <DetailSection title={t("Key", "密钥")}>
            <ListRowGroup>
              <SettingRow title="Key ID" description={<span className="font-mono">{meta.key_id}</span>} />
              <SettingRow title="Issuer ID" description={<span className="font-mono [overflow-wrap:anywhere]">{meta.issuer_id}</span>} />
              <SettingRow title={t("Updated", "更新时间")} description={updated} />
            </ListRowGroup>
          </DetailSection>
          {editing ? (
            <DetailSection title={t("Replace key", "更换密钥")}>{form}</DetailSection>
          ) : (
            <DetailSection title={t("Actions", "操作")}>
              <ListRowGroup>
                <SettingRow
                  title={t("Check the key", "检查密钥")}
                  description={t("Verify the stored key against App Store Connect for a bundle ID you enter.", "用你输入的 Bundle ID 在 App Store Connect 中验证已保存的密钥。")}
                >
                  <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                    {test.isPending ? t("Testing…", "测试中…") : t("Test connection", "测试连接")}
                  </Button>
                </SettingRow>
                <SettingRow
                  title={t("New key", "新密钥")}
                  description={t("Save another key in place of this one, for example after revoking it in App Store Connect.", "用另一个密钥替换这个，例如在 App Store Connect 中撤销它之后。")}
                >
                  <Button variant="outline" onClick={() => setEditing(true)}>{t("Replace key", "更换密钥")}</Button>
                </SettingRow>
              </ListRowGroup>
            </DetailSection>
          )}
          <DetailSection title={t("Danger zone", "危险操作")}>
            <DangerRow
              title={t("Remove key", "移除密钥")}
              description={t("TestFlight uploads for this app stop until a new key is saved.", "在保存新密钥之前，此应用将无法上传到 TestFlight。")}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t("Remove the App Store Connect key? TestFlight uploads for this app stop until a new key is saved.", "移除 App Store Connect 密钥？在保存新密钥之前，此应用将无法上传到 TestFlight。"))) {
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
