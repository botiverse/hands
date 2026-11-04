import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Apple, ChevronDown } from "lucide-react";
import {
  Badge,
  Button,
  Input,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "raft-ui";
import {
  deleteAscCredentials,
  getAscCredentials,
  setAscCredentials,
  verifyAscCredentials,
} from "../../lib/api";
import { useToast } from "../Toast";
import { useText } from "../../lib/locale";

/**
 * App Store Connect / TestFlight connector row for the Integrations page.
 * Moved out of the app Settings section unchanged: same queries, mutations
 * and form flow — the row is collapsed until configured, then expandable.
 */
export function TestFlightConnector({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["asc-credentials", appId],
    queryFn: () => getAscCredentials(appId),
  });
  const meta = creds.data?.asc_credentials ?? null;
  const [expanded, setExpanded] = useState(false);
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
      toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: (e as Error).message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAscCredentials(appId),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("TestFlight credentials removed", "TestFlight 凭据已移除") });
      qc.invalidateQueries({ queryKey: ["asc-credentials", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: (e as Error).message }),
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
      toast.show({ kind: "error", title: t("Test failed", "测试失败"), description: (e as Error).message });
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

  const form = (
    <div className="space-y-3">
      {!meta && (
        <ol className="text-xs text-foreground-muted list-decimal pl-4 space-y-1">
          <li>
            {t("In", "在")}{" "}
            <a
              className="text-info-strong hover:underline"
              href="https://appstoreconnect.apple.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              App Store Connect
            </a>
            {t(" → My Apps, create an app record for this bundle ID if one does not exist yet (TestFlight only needs the record — no store listing or review required).", " → 我的 App 中，如果尚无对应此 Bundle ID 的应用记录，请先创建（TestFlight 只需要记录，无需商店页面或审核）。")}
          </li>
          <li>
            {t("Go to", "前往")}{" "}
            <a
              className="text-info-strong hover:underline"
              href="https://appstoreconnect.apple.com/access/integrations/api"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("Users and Access → Integrations → App Store Connect API", "用户和访问 → 集成 → App Store Connect API")}
            </a>
            {t(" and generate a Team Key with the ", "，生成具有")}<strong>{t("App Manager", "App 管理员")}</strong>{t(" role (requires an Admin account).", "角色的团队密钥（需要管理员账号）。")}
          </li>
          <li>
            {t("Note the", "记下页面顶部的")} <strong>Issuer ID</strong>{t(" (top of that page) and the key's", "以及密钥的")} <strong>Key ID</strong>{t(", then download the", "，然后下载")} <span className="font-mono">AuthKey_XXXXXXXXXX.p8</span>{t(" file — Apple lets you download it", "文件；Apple 仅允许下载")} <strong>{t("once", "一次")}</strong>{t(".", "。")}
          </li>
          <li>{t("Paste all three below and save.", "将三项内容填入下方并保存。")}</li>
        </ol>
      )}
      <div className="flex flex-col gap-3 md:flex-row">
        <label className="flex-1 text-xs text-foreground-muted">
          Key ID
          <Input
            className="h-8! w-full text-sm! font-mono mt-1"
            placeholder="ABC123DEFG"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
          />
        </label>
        <label className="flex-1 text-xs text-foreground-muted">
          Issuer ID
          <Input
            className="h-8! w-full text-sm! font-mono mt-1"
            placeholder="12345678-90ab-cdef-1234-567890abcdef"
            value={issuerId}
            onChange={(e) => setIssuerId(e.target.value)}
          />
        </label>
      </div>
      <label className="block text-xs text-foreground-muted">
        {t("Private key (.p8 contents)", "私钥（.p8 文件内容）")}
        <Textarea
          className="w-full font-mono h-24 resize-y mt-1"
          placeholder={t("Paste the contents of the downloaded .p8 AuthKey file", "粘贴下载的 .p8 AuthKey 文件内容")}
          value={p8}
          onChange={(e) => setP8(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="xs" render={<label className="cursor-pointer" />}>
          {t("Load from .p8 file", "从 .p8 文件加载")}
          <input
            type="file"
            accept=".p8,.pem"
            className="hidden"
            onChange={(e) => readP8File(e.target.files?.[0])}
          />
        </Button>
        <div className="flex-1" />
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
        <Button
          variant="primary"
          disabled={!formValid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "…" : meta ? t("Replace credentials", "更换凭据") : t("Save & enable", "保存并启用")}
        </Button>
      </div>
      {p8.trim().length > 0 && !(p8.includes("BEGIN") && p8.includes("KEY")) && (
        <p className="text-xs text-warning-strong">
          {t("This does not look like a .p8 private key — paste the full PEM contents of the downloaded AuthKey file, including the header and footer lines.", "这不像是 .p8 私钥，请粘贴下载的 AuthKey 文件的完整 PEM 内容，包括开头和结尾行。")}
        </p>
      )}
      <p className="text-xs text-foreground-hint">
        {t("The App Store Connect app record must match the bundle ID your IPAs are signed with.", "App Store Connect 的应用记录必须与 IPA 签名使用的 Bundle ID 一致。")}
      </p>
    </div>
  );

  return (
    <section data-testid="testflight-connector" className="border-t border-line-hairline pt-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fill-muted text-foreground-muted">
          <Apple className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground-strong">TestFlight</h3>
          <p className="mt-0.5 text-xs text-foreground-muted">
            {t("App Store Connect API key used to upload builds of this app to TestFlight. Stored encrypted; the private key is never shown again after saving.", "用于将此应用构建上传到 TestFlight 的 App Store Connect API 密钥。密钥会加密保存；私钥保存后不会再次显示。")}
          </p>
        {meta ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
            <Badge variant="success">{t("Configured", "已配置")}</Badge>
            <span className="min-w-0 truncate font-mono">Key ID {meta.key_id}</span>
            <span className="min-w-0 truncate font-mono">{t("Issuer", "签发者")} {meta.issuer_id}</span>
            <span>{t(`updated ${new Date(meta.updated_at).toISOString().slice(0, 10)}`, `更新于 ${new Date(meta.updated_at).toISOString().slice(0, 10)}`)}</span>
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
              disabled={creds.isLoading}
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      disabled={test.isPending}
                      onClick={() => test.mutate()}
                    >
                      {test.isPending ? t("Testing…", "测试中…") : t("Test connection", "测试连接")}
                    </Button>
                  }
                />
                <TooltipContent>
                  {t("Verify the stored key against App Store Connect for this app's bundle id", "使用此应用的 Bundle ID 在 App Store Connect 中验证已保存的密钥")}
                </TooltipContent>
              </Tooltip>
              <Button variant="outline" onClick={() => setEditing(true)}>
                {t("Replace key", "更换密钥")}
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      t("Remove the App Store Connect key? TestFlight uploads for this app stop until a new key is saved.", "移除 App Store Connect 密钥？在保存新密钥之前，此应用将无法上传到 TestFlight。"),
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
