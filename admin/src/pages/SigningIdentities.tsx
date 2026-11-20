/**
 * Organization › Signing — signing keys and certificates held by Hands.
 *
 * One section per platform (iOS, macOS, Android), each a list of identities.
 * Opening one shows a side panel: the apps of that platform that may sign
 * with it (switches that apply at once), its details, and revoking it.
 *
 * Adding starts with a choice: create the key in Hands (recommended) or
 * upload an existing one. For iOS, App Store Connect issues the Distribution
 * certificate directly (Admin API key). Developer ID certificates can only be
 * created by the Account Holder on the Apple Developer site, so Hands keeps
 * the key and hands out a certificate request; the pending request is a row
 * whose Continue walks through taking it to Apple and bringing the .cer back.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Smartphone, TabletSmartphone, Trash2, X } from "lucide-react";
import {
  Badge,
  Banner,
  BannerDescription,
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
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowSubtitle,
  ListRowTitle,
  ListRowValue,
  Panel,
  PanelAction,
  PanelActions,
  PanelBody,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelSection,
  PanelTitle,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Step,
  Steps,
  Switch,
  Text,
  TextLink,
  TextLinkDownloadIcon,
  TextLinkExternalIcon,
} from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import {
  cancelSigningCertificateRequest,
  completeSigningCertificateRequest,
  createSigningCertificateRequest,
  exportSigningIdentityBackup,
  generateAndroidSigningIdentity,
  generateAppleIosSigningIdentity,
  grantSigningIdentity,
  listApps,
  listSigningApiKeySources,
  listSigningCertificateRequests,
  listSigningIdentities,
  revokeSigningIdentity,
  ungrantSigningIdentity,
  uploadSigningIdentity,
  type App,
  type SigningCertificateRequest,
  type SigningIdentity,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useLocale, useText } from "../lib/locale";
import { useToast } from "../components/Toast";

type Platform = "ios" | "macos" | "android";
type Kind = SigningIdentity["kind"];
type T = ReturnType<typeof useText>;

const PLATFORMS: Array<{
  id: Platform;
  kind: Kind;
  icon: ReactNode;
  name: string;
  hint: [string, string];
  add: [string, string];
  empty: [string, string];
  /** App platforms an identity of this kind can sign for. */
  appPlatforms: string[];
}> = [
  {
    id: "ios", kind: "apple_ios_distribution", icon: <Smartphone />, name: "iOS",
    hint: ["Hands makes the App Store profiles", "App Store 描述文件由 Hands 生成"],
    add: ["Add certificate", "添加证书"],
    empty: ["No distribution certificate yet. Add one to sign iOS builds.", "还没有分发证书。添加后即可签名 iOS 构建。"],
    appPlatforms: ["ios"],
  },
  {
    id: "macos", kind: "apple_developer_id", icon: <Laptop />, name: "macOS",
    hint: ["Developer ID, notarized by Hands", "Developer ID，由 Hands 公证"],
    add: ["Add certificate", "添加证书"],
    empty: ["No Developer ID yet. Add one to sign and notarize macOS builds.", "还没有 Developer ID。添加后即可签名并公证 macOS 构建。"],
    appPlatforms: ["electron", "tauri", "macos"],
  },
  {
    id: "android", kind: "android_keystore", icon: <TabletSmartphone />, name: "Android",
    hint: ["Hands signs the APKs and app bundles", "由 Hands 签名 APK 和 App Bundle"],
    add: ["Add key", "添加密钥"],
    empty: ["No key yet. Add one to sign Android builds.", "还没有密钥。添加后即可签名安卓构建。"],
    appPlatforms: ["android"],
  },
];

const PLATFORM_OF_KIND: Record<Kind, (typeof PLATFORMS)[number]> = Object.fromEntries(
  PLATFORMS.map((p) => [p.kind, p]),
) as Record<Kind, (typeof PLATFORMS)[number]>;

const APPLE_CERTIFICATES = "https://developer.apple.com/account/resources/certificates/add";
const DAY = 86_400_000;

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking right after click() can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const fileBase = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-");

function certDate(value: string | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value.replace(/\s+/g, " "));
  return Number.isFinite(at) ? at : null;
}

function expiry(at: number, locale: string, t: T) {
  const date = new Date(at).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
  const days = Math.round((at - Date.now()) / DAY);
  const relative = days < 0
    ? t("Expired", "已过期")
    : days < 60
      ? t(`Expires in ${days} days`, `${days} 天后到期`)
      : days < 730
        ? t(`in ${Math.round(days / 30)} months`, `${Math.round(days / 30)} 个月后`)
        : t(`in ${Math.round(days / 365)} years`, `${Math.round(days / 365)} 年后`);
  return { date, relative, soon: days < 30 };
}

function kindLabel(kind: Kind, t: T) {
  return kind === "apple_ios_distribution" ? "Apple Distribution" : kind === "apple_developer_id" ? "Developer ID Application" : t("Keystore", "Keystore");
}

export function SigningTab({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<Platform | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);
  const identities = useQuery({ queryKey: ["signing-identities", orgId], queryFn: () => listSigningIdentities(orgId), enabled: canManage });
  const requests = useQuery({ queryKey: ["signing-certificate-requests", orgId], queryFn: () => listSigningCertificateRequests(orgId), enabled: canManage });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });

  if (!canManage) {
    return <Text.Sans size="small" variant="muted">{t("Only organization admins manage signing identities.", "只有组织管理员可以管理签名身份。")}</Text.Sans>;
  }
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["signing-identities", orgId] });
    qc.invalidateQueries({ queryKey: ["signing-certificate-requests", orgId] });
  };
  const done = (title: string) => {
    toast.show({ kind: "success", title });
    refresh();
  };
  const rows = identities.data?.signing_identities ?? [];
  const pending = requests.data?.certificate_requests ?? [];
  const orgApps = (apps.data?.apps ?? []).filter((a) => a.org_id === orgId && !a.archived);
  const open = rows.find((r) => r.id === openId) ?? null;
  const continuingRequest = pending.find((r) => r.id === continuing) ?? null;

  return (
    <div className={open ? "grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]" : ""}>
      <div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
        <Text.Sans size="small" variant="muted">
          {t(
            "Keys stay in Hands, encrypted. CI uploads an unsigned build and Hands signs it, so no key ever reaches CI.",
            "密钥加密保存在 Hands。CI 上传未签名的构建，由 Hands 签名，密钥不会进入 CI。",
          )}
        </Text.Sans>
        {identities.isLoading && <Skeleton className="h-24 w-full" />}
        {identities.error && <Text.Sans size="small" className="text-danger">{errorMessage(identities.error)}</Text.Sans>}
        {identities.data && PLATFORMS.map((p) => {
          const mine = rows.filter((r) => r.kind === p.kind);
          const waiting = pending.filter((r) => r.kind === p.kind);
          return (
            <section key={p.id} aria-labelledby={`signing-${p.id}`} className="stack-y-3">
              <div className="flex items-center gap-2">
                <h2 id={`signing-${p.id}`} className="flex items-center gap-2 text-footnote font-bold text-foreground-hint [&_svg]:size-4">
                  <span aria-hidden className="flex">{p.icon}</span>
                  {p.name}
                </h2>
                <span className="min-w-0 truncate text-footnote text-foreground-hint">{t(...p.hint)}</span>
                <TextLink className="ml-auto shrink-0 text-footnote" onClick={() => setAdding(p.id)}>{t(...p.add)}</TextLink>
              </div>
              <ListRowGroup>
                {mine.map((identity) => (
                  <IdentityRow key={identity.id} identity={identity} selected={openId === identity.id} onOpen={() => setOpenId(identity.id)} />
                ))}
                {waiting.map((r) => <PendingRow key={r.id} request={r} onContinue={() => setContinuing(r.id)} />)}
                {mine.length === 0 && waiting.length === 0 && (
                  <ListRow variant="plain" interactive={false}>
                    <ListRowBody><ListRowDescription wrap>{t(...p.empty)}</ListRowDescription></ListRowBody>
                  </ListRow>
                )}
              </ListRowGroup>
            </section>
          );
        })}
      </div>
      {open && (
        <IdentityPanel
          key={open.id}
          orgId={orgId}
          identity={open}
          orgApps={orgApps}
          onClose={() => setOpenId(null)}
          onRevoked={() => { setOpenId(null); done(t("Revoked", "已撤销")); }}
          onChanged={refresh}
        />
      )}
      {adding && (
        <AddDialog
          key={adding}
          orgId={orgId}
          platform={adding}
          onClose={() => setAdding(null)}
          onIdentity={(title) => { setAdding(null); done(title); }}
          onRequest={(id) => { setAdding(null); refresh(); setContinuing(id); }}
        />
      )}
      {continuingRequest && (
        <ContinueDialog
          key={continuingRequest.id}
          orgId={orgId}
          request={continuingRequest}
          onClose={() => setContinuing(null)}
          onDone={() => { setContinuing(null); done(t("Certificate added", "证书已添加")); }}
          onCancelled={() => { setContinuing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function IdentityRow({ identity, selected, onOpen }: { identity: SigningIdentity; selected: boolean; onOpen: () => void }) {
  const t = useText();
  const { locale } = useLocale();
  const m = identity.metadata;
  const at = certDate(m.not_after);
  const exp = at === null ? null : expiry(at, locale, t);
  return (
    <ListRow variant="plain" selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowBody>
        <ListRowTitle>{identity.name}</ListRowTitle>
        <ListRowSubtitle>
          {kindLabel(identity.kind, t)}
          {m.team_id ? <> · {t("team", "团队")} <span className="font-mono">{m.team_id}</span></> : null}
          {m.key_alias ? <> · {t("alias", "别名")} <span className="font-mono">{m.key_alias}</span></> : null}
        </ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>
            {identity.apps.length
              ? t(`Signs for ${identity.apps.map((a) => a.slug).join(", ")}`, `用于 ${identity.apps.map((a) => a.slug).join("、")}`)
              : t("Not granted to any app", "还没有授权给任何应用")}
          </ListRowDescription>
          {exp?.soon && <Badge appearance="soft" variant="warning">{exp.relative}</Badge>}
        </ListRowBottom>
      </ListRowBody>
      {exp && <ListRowValue>{exp.date}</ListRowValue>}
      <ListRowChevron />
    </ListRow>
  );
}

function PendingRow({ request, onContinue }: { request: SigningCertificateRequest; onContinue: () => void }) {
  const t = useText();
  const { locale } = useLocale();
  const requested = new Date(request.created_at).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTitle>{request.name}</ListRowTitle>
        <ListRowSubtitle>{kindLabel(request.kind, t)}</ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>{t(`Requested ${requested}`, `${requested} 申请`)}</ListRowDescription>
          <Badge appearance="soft" variant="muted">{t("Waiting for Apple", "等待 Apple 签发")}</Badge>
        </ListRowBottom>
      </ListRowBody>
      <Button size="md" onClick={onContinue}>{t("Continue", "继续")}</Button>
    </ListRow>
  );
}

function IdentityPanel({ orgId, identity, orgApps, onClose, onRevoked, onChanged }: {
  orgId: string;
  identity: SigningIdentity;
  orgApps: App[];
  onClose: () => void;
  onRevoked: () => void;
  onChanged: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const toast = useToast();
  const [revoking, setRevoking] = useState(false);
  const platform = PLATFORM_OF_KIND[identity.kind];
  const thing = identity.kind === "android_keystore" ? t("key", "密钥") : t("certificate", "证书");
  const granted = new Set(identity.apps.map((a) => a.app_id));
  // Apps of this platform, and any app granted before that can't use it, so it can be turned off.
  const candidates = orgApps.filter((a) => platform.appPlatforms.includes(a.platform) || granted.has(a.id));
  const m = identity.metadata;
  const at = certDate(m.not_after);
  const exp = at === null ? null : expiry(at, locale, t);
  const onError = (title: string) => (e: unknown) => toast.show({ kind: "error", title, description: errorMessage(e) });
  const grant = useMutation({
    mutationFn: ({ appId, on }: { appId: string; on: boolean }) =>
      on ? grantSigningIdentity(orgId, identity.id, appId) : ungrantSigningIdentity(orgId, identity.id, appId),
    onSuccess: onChanged,
    onError: onError(t("Could not change the app", "应用授权修改失败")),
  });
  const backup = useMutation({
    mutationFn: () => exportSigningIdentityBackup(orgId, identity.id),
    onSuccess: (res) => {
      download(`${fileBase(identity.name)}.hands-key-backup.json`, `${JSON.stringify({
        format: "PKCS12 keystore, base64",
        keystore_b64: res.keystore_b64,
        key_alias: res.key_alias,
        store_password: res.store_password,
        key_password: res.key_password,
        restore: "Decode keystore_b64 from base64 into a .p12 file; open it with store_password.",
      }, null, 2)}\n`);
      toast.show({ kind: "success", title: t("Backup downloaded. Store it offline; if it did not arrive, retry within 10 minutes.", "备份已下载。请离线保存；如果没有收到，10 分钟内可以重试。") });
      onChanged();
    },
    onError: onError(t("Backup failed", "备份失败")),
  });
  const revoke = useMutation({
    mutationFn: () => revokeSigningIdentity(orgId, identity.id),
    onSuccess: onRevoked,
    onError: onError(t("Revoke failed", "撤销失败")),
  });
  const canBackup = identity.origin === "generated" && identity.kind === "android_keystore"
    && (identity.backup_exported_at === null || identity.backup_exported_at > Date.now() - 10 * 60 * 1000);
  const apiKey = m.notary_key_id ?? m.asc_key_id;

  return (
    <Panel edge="attached" aria-label={identity.name} className="flex min-h-0 flex-col rounded-container border border-line-seam bg-layer-canvas lg:sticky lg:top-4">
      <PanelHeader>
        <PanelHeaderContent>
          <PanelHeading><PanelTitle render={<h2 />}>{identity.name}</PanelTitle></PanelHeading>
        </PanelHeaderContent>
        <PanelActions>
          <PanelAction aria-label={t("Close", "关闭")} onClick={onClose}><X /></PanelAction>
        </PanelActions>
      </PanelHeader>
      <PanelBody>
        <PanelSection className="flex flex-col gap-3">
          <div>
            <Text.Sans render={<h3 />} size="group">{t("Apps", "应用")}</Text.Sans>
            <Text.Sans className="mt-1" size="small" variant="muted">
              {t(`Builds of the apps turned on here are signed with this ${thing}.`, `这里打开的应用，构建会用这个${thing}签名。`)}
            </Text.Sans>
          </div>
          {candidates.length === 0 ? (
            <Text.Sans size="small" variant="muted">{t(`No ${platform.name} app in this organization yet.`, `本组织还没有 ${platform.name} 应用。`)}</Text.Sans>
          ) : (
            <ListRowGroup>
              {candidates.map((app) => {
                const titleId = `grant-${identity.id}-${app.id}`;
                const foreign = !platform.appPlatforms.includes(app.platform);
                return (
                  <ListRow key={app.id} variant="plain" interactive={false}>
                    <ListRowBody>
                      <ListRowTitle id={titleId}>{app.slug}</ListRowTitle>
                      <ListRowSubtitle>
                        {foreign
                          ? t(`${app.platform} app: this ${thing} can't sign it`, `${app.platform} 应用：这个${thing}签不了它`)
                          : app.name}
                      </ListRowSubtitle>
                    </ListRowBody>
                    <Switch
                      checked={granted.has(app.id)}
                      disabled={grant.isPending}
                      onCheckedChange={(on) => grant.mutate({ appId: app.id, on })}
                      aria-labelledby={titleId}
                    />
                  </ListRow>
                );
              })}
            </ListRowGroup>
          )}
        </PanelSection>

        <PanelSection className="flex flex-col gap-3">
          <Text.Sans render={<h3 />} size="group">{t("Details", "详情")}</Text.Sans>
          <DescriptionList direction="horizontal">
            <DescriptionItem>
              <DescriptionTerm>{t("Kind", "类型")}</DescriptionTerm>
              <DescriptionDetails>{kindLabel(identity.kind, t)}</DescriptionDetails>
            </DescriptionItem>
            {m.team_id && (
              <DescriptionItem>
                <DescriptionTerm>{t("Team", "团队")}</DescriptionTerm>
                <DescriptionDetails><span className="font-mono">{m.team_id}</span></DescriptionDetails>
              </DescriptionItem>
            )}
            {m.key_alias && (
              <DescriptionItem>
                <DescriptionTerm>{t("Alias", "别名")}</DescriptionTerm>
                <DescriptionDetails><span className="font-mono">{m.key_alias}</span></DescriptionDetails>
              </DescriptionItem>
            )}
            {identity.kind !== "android_keystore" && (
              <DescriptionItem>
                <DescriptionTerm>{t("API key", "API key")}</DescriptionTerm>
                <DescriptionDetails>
                  {apiKey ? <span className="font-mono">{apiKey}</span> : <span className="text-foreground-muted">{t("None", "无")}</span>}
                  {m.api_key_from_app && <span className="text-foreground-muted"> {t(`(from ${m.api_key_from_app})`, `（来自 ${m.api_key_from_app}）`)}</span>}
                </DescriptionDetails>
              </DescriptionItem>
            )}
            {identity.kind === "apple_developer_id" && (
              <DescriptionItem>
                <DescriptionTerm>{t("Notarization", "公证")}</DescriptionTerm>
                <DescriptionDetails>{m.notary_key_id ? t("On", "已开启") : t("Off: builds are signed but not notarized", "未开启：只签名，不公证")}</DescriptionDetails>
              </DescriptionItem>
            )}
            {identity.kind === "apple_ios_distribution" && (
              <DescriptionItem>
                <DescriptionTerm>{t("Profiles", "描述文件")}</DescriptionTerm>
                <DescriptionDetails>
                  {m.asc_key_id
                    ? t("Made by Hands for the App Store", "由 Hands 为 App Store 生成")
                    : t(`${m.provisioning_profile_count ?? 0} uploaded`, `已上传 ${m.provisioning_profile_count ?? 0} 个`)}
                </DescriptionDetails>
              </DescriptionItem>
            )}
            <DescriptionItem>
              <DescriptionTerm>{t("Added", "来源")}</DescriptionTerm>
              <DescriptionDetails>
                {identity.origin === "generated"
                  ? t("Made in Hands", "在 Hands 中生成")
                  : identity.kind === "android_keystore" ? t("Uploaded keystore", "上传的 keystore") : t("Uploaded as a .p12", "以 .p12 上传")}
              </DescriptionDetails>
            </DescriptionItem>
            {exp && (
              <DescriptionItem>
                <DescriptionTerm>{t("Expires", "到期")}</DescriptionTerm>
                <DescriptionDetails className="flex flex-wrap items-center gap-2">
                  <span>{exp.date}</span>
                  {exp.soon
                    ? <Badge appearance="soft" variant="warning">{exp.relative}</Badge>
                    : <span className="text-foreground-muted">{exp.relative}</span>}
                </DescriptionDetails>
              </DescriptionItem>
            )}
            {m.sha256_fingerprint && (
              <DescriptionItem>
                <DescriptionTerm>SHA-256</DescriptionTerm>
                <DescriptionDetails>
                  <CopyableCodeRoot size="sm">
                    <CopyableCode className="[overflow-wrap:anywhere]">{m.sha256_fingerprint.toUpperCase()}</CopyableCode>
                    <CopyableCodeAction aria-label={t("Copy SHA-256 fingerprint", "复制 SHA-256 指纹")} />
                  </CopyableCodeRoot>
                </DescriptionDetails>
              </DescriptionItem>
            )}
          </DescriptionList>
          {canBackup && (
            <TextLink
              className="self-start"
              disabled={backup.isPending}
              onClick={() => {
                if (confirm(t("Download the one-time backup? It can only be downloaded once.", "下载一次性备份？只能下载一次。"))) backup.mutate();
              }}
            >
              {t("Download backup (once)", "下载备份（仅一次）")}
              <TextLinkDownloadIcon label={t("(downloads a file)", "（下载文件）")} />
            </TextLink>
          )}
        </PanelSection>

        <PanelSection className="flex flex-col gap-3">
          <Text.Sans render={<h3 />} size="group">{t("Danger zone", "危险操作")}</Text.Sans>
          <ListRowGroup>
            <ListRow variant="plain" tone="danger" onClick={() => setRevoking(true)}>
              <ListRowIcon><Trash2 /></ListRowIcon>
              <ListRowBody>
                <ListRowTitle>{t(`Revoke ${thing}`, `撤销${thing}`)}</ListRowTitle>
                <ListRowDescription wrap>{t("No app can sign with it any more. This can't be undone in Hands.", "之后任何应用都不能再用它签名，Hands 里无法撤回。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          </ListRowGroup>
        </PanelSection>
      </PanelBody>

      <Dialog open={revoking} onOpenChange={setRevoking}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t(`Revoke ${thing}?`, `撤销${thing}？`)}</DialogTitle>
            <DialogClose />
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <DialogDescription>
              {t(
                `Builds of ${identity.apps.map((a) => a.slug).join(", ") || "its apps"} can't be signed until you add another ${thing}.`,
                `${identity.apps.map((a) => a.slug).join("、") || "这些应用"}的构建在添加新的${thing}之前都无法签名。`,
              )}
            </DialogDescription>
            <Banner status="destructive" size="sm">
              <BannerDescription>
                {identity.kind === "android_keystore"
                  ? t("Google Play accepts updates only from the same key, unless you reset it there. This can't be undone.", "除非在 Google Play 重置上传密钥，否则 Google Play 只接受同一个密钥签名的更新。此操作无法撤回。")
                  : t("The certificate stays valid at Apple; revoke it on the Apple Developer site if it should stop working everywhere. This can't be undone in Hands.", "证书在 Apple 那边仍然有效；如果要彻底停用，请到 Apple Developer 网站撤销。Hands 里无法撤回。")}
              </BannerDescription>
            </Banner>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button variant="danger" size="lg" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              {t(`Revoke ${thing}`, `撤销${thing}`)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

// ---------- Adding ----------

type KeyChoice = string; // "app:<appId>" | "new" | "none"

/** An App Store Connect API key: reuse one an app here holds, enter a new one, or (where allowed) none. */
function ApiKeyField({ orgId, purpose, value, onChange, noneLabel, keyId, setKeyId, issuerId, setIssuerId, setP8 }: {
  orgId: string;
  purpose: "notary" | "profiles" | "certificate";
  value: KeyChoice;
  onChange: (v: KeyChoice) => void;
  noneLabel?: string | undefined;
  keyId: string; setKeyId: (v: string) => void;
  issuerId: string; setIssuerId: (v: string) => void;
  setP8: (f: File | null) => void;
}) {
  const t = useText();
  const sources = useQuery({ queryKey: ["signing-api-keys", orgId], queryFn: () => listSigningApiKeySources(orgId) });
  const keys = sources.data?.api_keys ?? [];
  return (
    <Field>
      <FieldLabel id={`api-key-${purpose}`} nativeLabel={false} render={<div />}>
        {purpose === "notary" ? t("App Store Connect API key for notarization", "公证用的 App Store Connect API key") : t("App Store Connect API key", "App Store Connect API key")}
      </FieldLabel>
      <RadioGroup aria-labelledby={`api-key-${purpose}`} value={value} onValueChange={(v) => onChange(String(v))} className="grid gap-3">
        {keys.map((k) => (
          <label key={k.app_id} className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <RadioGroupItem value={`app:${k.app_id}`} aria-label={t(`Use the key of ${k.slug} (Key ID ${k.key_id})`, `使用 ${k.slug} 的 key（Key ID ${k.key_id}）`)} />
            <span>{t(`Use the key of ${k.slug}`, `使用 ${k.slug} 的 key`)} (<span className="font-mono">{k.key_id}</span>)</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
          <RadioGroupItem value="new" />
          <span>{t("Enter a new key", "填写新的 key")}</span>
        </label>
        {noneLabel && (
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <RadioGroupItem value="none" />
            <span>{noneLabel}</span>
          </label>
        )}
      </RadioGroup>
      {value === "new" && (
        <div className="mt-3 grid gap-3">
          <Input placeholder="Key ID" className="font-mono" aria-label="Key ID" value={keyId} onChange={(e) => setKeyId(e.currentTarget.value)} />
          <Input placeholder="Issuer ID" className="font-mono" aria-label="Issuer ID" value={issuerId} onChange={(e) => setIssuerId(e.currentTarget.value)} />
          <FilePick label="AuthKey_XXXX.p8" accept=".p8" onFile={setP8} />
        </div>
      )}
      <FieldDescription>
        {purpose === "certificate"
          ? t("The key needs the Admin role in App Store Connect.", "这把 key 需要 App Store Connect 的 Admin 角色。")
          : purpose === "profiles"
            ? t("With a key (App Manager or Admin role), Hands makes and renews the App Store profiles.", "有 key（App Manager 或 Admin 角色）时，Hands 自动生成和续期 App Store 描述文件。")
            : t("Any role works for notarization.", "公证对 key 的角色没有要求。")}
      </FieldDescription>
    </Field>
  );
}

/** A file input that looks like a button and shows the chosen file. */
function FilePick({ label, accept, multiple, onFile, onFiles }: {
  label: string; accept: string; multiple?: boolean; onFile?: (f: File | null) => void; onFiles?: (f: File[]) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  return (
    <label className="flex flex-wrap items-center gap-3 text-sm">
      <span className="inline-flex h-9 cursor-pointer items-center rounded-control border border-line-control px-3 font-medium text-foreground hover:bg-fill-muted">{label}</span>
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        aria-label={label}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          setNames(files.map((f) => f.name));
          onFile?.(files[0] ?? null);
          onFiles?.(files);
        }}
      />
      {names.length > 0 && <span className="font-mono text-foreground-muted">{names.join(", ")}</span>}
    </label>
  );
}

async function resolveKey(choice: KeyChoice, keyId: string, issuerId: string, p8: File | null) {
  if (choice.startsWith("app:")) return { from_app: choice.slice(4) };
  if (choice === "new" && p8) return { key_id: keyId.trim(), issuer_id: issuerId.trim(), p8: await p8.text() };
  return null;
}

function AddDialog({ orgId, platform, onClose, onIdentity, onRequest }: {
  orgId: string;
  platform: Platform;
  onClose: () => void;
  onIdentity: (title: string) => void;
  onRequest: (requestId: string) => void;
}) {
  const t = useText();
  const toast = useToast();
  const p = PLATFORMS.find((x) => x.id === platform)!;
  const [step, setStep] = useState<"choose" | "create" | "upload">("choose");
  const [method, setMethod] = useState<string | null>("create");
  const [name, setName] = useState("");
  const [keyChoice, setKeyChoice] = useState<KeyChoice>(platform === "ios" ? "new" : "none");
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [p8, setP8] = useState<File | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [alias, setAlias] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [profiles, setProfiles] = useState<File[]>([]);
  // iOS without an Admin key: a request file for the Apple Developer site instead.
  const [viaRequest, setViaRequest] = useState(false);
  const fail = (e: unknown) => toast.show({ kind: "error", title: step === "upload" ? t("Upload failed", "上传失败") : t("Create failed", "创建失败"), description: errorMessage(e) });

  const create = useMutation({
    mutationFn: async (): Promise<{ identity: true } | { request: string }> => {
      const key = await resolveKey(keyChoice, keyId, issuerId, p8);
      if (platform === "android") {
        await generateAndroidSigningIdentity(orgId, { name: name.trim() });
        return { identity: true };
      }
      if (platform === "ios" && !viaRequest) {
        await generateAppleIosSigningIdentity(orgId, { name: name.trim(), asc: key ?? {} });
        return { identity: true };
      }
      const res = await createSigningCertificateRequest(orgId, {
        kind: p.kind, name: name.trim(), ...(platform === "ios" ? { asc: key } : { notary: key }),
      });
      return { request: res.certificate_request.id };
    },
    onSuccess: (res) => ("request" in res ? onRequest(res.request) : onIdentity(t("Created", "已创建"))),
    onError: fail,
  });
  const upload = useMutation({
    mutationFn: async () => {
      if (platform === "android") {
        return uploadSigningIdentity(orgId, {
          kind: "android_keystore", name: name.trim(), keystore_b64: await fileBase64(file!),
          store_password: password, key_alias: alias.trim(), ...(keyPassword ? { key_password: keyPassword } : {}),
        });
      }
      const key = await resolveKey(keyChoice, keyId, issuerId, p8);
      return uploadSigningIdentity(orgId, {
        kind: p.kind, name: name.trim(), p12_b64: await fileBase64(file!), p12_password: password,
        ...(platform === "ios" ? { asc: key, provisioning_profiles_b64: await Promise.all(profiles.map(fileBase64)) } : { notary: key }),
      });
    },
    onSuccess: () => onIdentity(t("Uploaded", "已上传")),
    onError: fail,
  });

  const keyMissing = keyChoice === "new" && (!p8 || !keyId.trim() || !issuerId.trim());
  const nameMissing = !name.trim();
  const createDisabled = create.isPending || nameMissing || keyMissing || (platform === "ios" && keyChoice === "none");
  const uploadDisabled = upload.isPending || nameMissing || !file || keyMissing
    || (platform === "android" && (!password || !alias.trim()))
    || (platform === "ios" && keyChoice === "none" && profiles.length === 0);

  const choices = platform === "android"
    ? [
      { value: "create", label: <span className="inline-flex items-center gap-2">{t("Create in Hands", "在 Hands 里新建")}<Badge appearance="outline">{t("Recommended", "推荐")}</Badge></span>, description: t("Hands makes an RSA 4096 key, valid for 30 years. You can download one backup.", "Hands 生成 RSA 4096 密钥，有效期 30 年，可以下载一次备份。") },
      { value: "upload", label: t("Upload a keystore", "上传 keystore"), description: t("A PKCS12 keystore with its passwords, for an app already on Google Play.", "带密码的 PKCS12 keystore，适合已上架 Google Play 的应用。") },
    ]
    : [
      { value: "create", label: <span className="inline-flex items-center gap-2">{t("Create in Hands", "在 Hands 里新建")}<Badge appearance="outline">{t("Recommended", "推荐")}</Badge></span>, description: platform === "ios"
        ? t("Hands makes the key and Apple issues the certificate. No Keychain Access, no .p12.", "Hands 生成密钥，Apple 签发证书。不用钥匙串，也不用 .p12。")
        : t("Hands makes the key and a request file; the Account Holder turns it into a certificate on the Apple Developer site.", "Hands 生成密钥和请求文件；Account Holder 在 Apple Developer 网站用它创建证书。") },
      { value: "upload", label: t("Upload a .p12", "上传 .p12"), description: t("Exported from Keychain Access, with its password.", "从钥匙串导出的 .p12 和密码。") },
    ];

  const title = step === "choose" ? t(...p.add) : step === "upload"
    ? (platform === "android" ? t("Upload a keystore", "上传 keystore") : t("Upload a .p12", "上传 .p12"))
    : platform === "android" ? t("Create key", "新建密钥") : t("Create certificate", "新建证书");
  const back = <TextLink variant="muted" className="mr-auto" onClick={() => setStep("choose")}>{t("Back", "返回")}</TextLink>;
  const cancel = <DialogClose render={<Button variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>;
  const nameField = (
    <Field>
      <FieldLabel htmlFor="signing-name">{t("Name", "名称")}</FieldLabel>
      <Input id="signing-name" value={name} onChange={(e) => setName(e.currentTarget.value)} aria-required />
    </Field>
  );
  const keyField = (purpose: "notary" | "profiles" | "certificate", noneLabel?: string) => (
    <ApiKeyField orgId={orgId} purpose={purpose} value={keyChoice} onChange={setKeyChoice} noneLabel={noneLabel}
      keyId={keyId} setKeyId={setKeyId} issuerId={issuerId} setIssuerId={setIssuerId} setP8={setP8} />
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogClose />
        </DialogHeader>

        {step === "choose" && (
          <>
            <DialogBody className="grid gap-4">
              <DialogDescription>
                {platform === "android"
                  ? t("Hands keeps the key and signs every Android build with it.", "Hands 保管密钥，用它签名每个安卓构建。")
                  : platform === "ios"
                    ? t("For signing iOS builds for TestFlight and the App Store.", "用于签名上传 TestFlight 和 App Store 的 iOS 构建。")
                    : t("For signing and notarizing macOS builds distributed outside the Mac App Store.", "用于签名并公证在 Mac App Store 之外分发的 macOS 构建。")}
              </DialogDescription>
              <ChoiceList aria-label={t("How to add it", "添加方式")} searchLabel={t("Search", "搜索")} clearSearchLabel={t("Clear search", "清除搜索")}
                items={choices} value={method} onValueChange={setMethod} />
            </DialogBody>
            <DialogFooter>
              {cancel}
              <Button variant="primary" size="lg" onClick={() => setStep(method === "upload" ? "upload" : "create")}>{t("Continue", "继续")}</Button>
            </DialogFooter>
          </>
        )}

        {step === "create" && (
          <>
            <DialogBody className="grid gap-5">
              {nameField}
              {platform === "ios" && keyField(viaRequest ? "profiles" : "certificate")}
              {platform === "ios" && (
                <TextLink variant="muted" className="justify-self-start text-footnote" onClick={() => setViaRequest(!viaRequest)}>
                  {viaRequest
                    ? t("Let Hands ask Apple directly (Admin key)", "改为由 Hands 直接向 Apple 申请（需要 Admin key）")
                    : t("No Admin key? Make a request file for the Apple Developer site instead", "没有 Admin key？改为生成请求文件，到 Apple Developer 网站申请")}
                </TextLink>
              )}
              {platform === "macos" && keyField("notary", t("No notarization", "不公证"))}
              {platform === "macos" && (
                <Text.Sans size="small" variant="muted">
                  {t("Next, Hands gives you a request file to take to the Apple Developer site. Only the Account Holder can create Developer ID certificates.", "下一步 Hands 会给你一个请求文件，拿到 Apple Developer 网站申请证书。只有 Account Holder 能创建 Developer ID 证书。")}
                </Text.Sans>
              )}
            </DialogBody>
            <DialogFooter>
              {back}
              {cancel}
              <Button variant="primary" size="lg" disabled={createDisabled} onClick={() => create.mutate()}>
                {platform === "android" ? t("Create key", "新建密钥") : platform === "ios" && !viaRequest ? t("Create certificate", "新建证书") : t("Make request", "生成请求")}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "upload" && (
          <>
            <DialogBody className="grid gap-5">
              {nameField}
              <Field>
                <FieldLabel nativeLabel={false} render={<div />}>{platform === "android" ? t("Keystore (.p12 / PKCS12)", "Keystore（.p12 / PKCS12）") : t("Certificate (.p12)", "证书（.p12）")}</FieldLabel>
                <FilePick label={platform === "android" ? t("Choose keystore", "选择 keystore") : t("Choose .p12 file", "选择 .p12 文件")} accept=".p12,.pfx,.keystore,.jks" onFile={setFile} />
              </Field>
              <Field>
                <FieldLabel htmlFor="signing-password">{platform === "android" ? t("Store password", "Store 密码") : t("Password", "密码")}</FieldLabel>
                <Input id="signing-password" type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
              </Field>
              {platform === "android" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="signing-alias">{t("Key alias", "Key alias")}</FieldLabel>
                    <Input id="signing-alias" className="font-mono" value={alias} onChange={(e) => setAlias(e.currentTarget.value)} aria-required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="signing-key-password">{t("Key password (optional)", "Key 密码（可选）")}</FieldLabel>
                    <Input id="signing-key-password" type="password" value={keyPassword} onChange={(e) => setKeyPassword(e.currentTarget.value)} />
                    <FieldDescription>{t("Only if it differs from the store password.", "仅当与 store 密码不同时填写。")}</FieldDescription>
                  </Field>
                </>
              )}
              {platform === "ios" && keyField("profiles", t("No key: I upload provisioning profiles", "不用 key：我自己上传描述文件"))}
              {platform === "ios" && keyChoice === "none" && (
                <Field>
                  <FieldLabel nativeLabel={false} render={<div />}>{t("App Store provisioning profiles", "App Store 描述文件")}</FieldLabel>
                  <FilePick label={t("Choose .mobileprovision files", "选择 .mobileprovision 文件")} accept=".mobileprovision" multiple onFiles={setProfiles} />
                  <FieldDescription>{t("One per app. Upload again when one expires or an app is added.", "每个应用一个；过期或新增应用时需要重新上传。")}</FieldDescription>
                </Field>
              )}
              {platform === "macos" && keyField("notary", t("No notarization", "不公证"))}
            </DialogBody>
            <DialogFooter>
              {back}
              {cancel}
              <Button variant="primary" size="lg" disabled={uploadDisabled} onClick={() => upload.mutate()}>{t("Upload", "上传")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A request waiting for Apple: download it, create the certificate there, bring the .cer back. */
function ContinueDialog({ orgId, request, onClose, onDone, onCancelled }: {
  orgId: string;
  request: SigningCertificateRequest;
  onClose: () => void;
  onDone: () => void;
  onCancelled: () => void;
}) {
  const t = useText();
  const toast = useToast();
  const [current, setCurrent] = useState(1);
  const [cer, setCer] = useState<File | null>(null);
  const certName = request.kind === "apple_developer_id" ? "Developer ID Application" : "Apple Distribution";
  const csrFile = `${fileBase(request.name)}.certSigningRequest`;
  const complete = useMutation({
    mutationFn: async () => completeSigningCertificateRequest(orgId, request.id, await fileBase64(cer!)),
    onSuccess: onDone,
    onError: (e) => toast.show({ kind: "error", title: t("Could not add the certificate", "证书添加失败"), description: errorMessage(e) }),
  });
  const cancel = useMutation({
    mutationFn: () => cancelSigningCertificateRequest(orgId, request.id),
    onSuccess: onCancelled,
    onError: (e) => toast.show({ kind: "error", title: t("Cancel failed", "取消失败"), description: errorMessage(e) }),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t(`Finish ${request.name}`, `完成 ${request.name}`)}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="grid gap-5">
          <DialogDescription>
            {request.kind === "apple_developer_id"
              ? t("Apple issues Developer ID certificates only on its own site, to the Account Holder. Hands keeps the private key; you carry the request there and the certificate back.", "Apple 只在自己的网站上给 Account Holder 签发 Developer ID 证书。私钥留在 Hands；你把请求文件带过去，再把证书带回来。")
              : t("Hands keeps the private key; you carry the request to the Apple Developer site and the certificate back.", "私钥留在 Hands；你把请求文件带到 Apple Developer 网站，再把证书带回来。")}
          </DialogDescription>
          <Steps vertical current={cer ? 4 : current}>
            <Step
              title={t("Download the request", "下载请求文件")}
              description={
                <TextLink onClick={() => { download(csrFile, request.csr_pem); setCurrent((c) => Math.max(c, 2)); }}>
                  <span className="font-mono">{csrFile}</span>
                  <TextLinkDownloadIcon label={t("(downloads a file)", "（下载文件）")} />
                </TextLink>
              }
            />
            <Step
              title={t(`Create a ${certName} certificate from it`, `用它创建 ${certName} 证书`)}
              description={
                <span>
                  {t(`On the Apple Developer site, choose ${certName} and upload the request. `, `在 Apple Developer 网站选择 ${certName}，上传请求文件。`)}
                  <TextLink
                    render={<a href={APPLE_CERTIFICATES} target="_blank" rel="noopener noreferrer" />}
                    nativeButton={false}
                    onClick={() => setCurrent((c) => Math.max(c, 3))}
                  >
                    {t("Open Apple Developer", "打开 Apple Developer")}
                    <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
                  </TextLink>
                </span>
              }
            />
            <Step
              title={t("Upload the .cer", "上传 .cer")}
              description={<span className="mt-2 inline-flex"><FilePick label={t("Choose .cer file", "选择 .cer 文件")} accept=".cer,.crt,.pem" onFile={setCer} /></span>}
            />
          </Steps>
        </DialogBody>
        <DialogFooter>
          <TextLink
            variant="muted"
            className="mr-auto"
            disabled={cancel.isPending}
            onClick={() => {
              if (confirm(t(`Cancel the request ${request.name}? Its key is deleted.`, `取消请求 ${request.name}？它的密钥会被删除。`))) cancel.mutate();
            }}
          >
            {t("Cancel request", "取消请求")}
          </TextLink>
          <DialogClose render={<Button variant="ghost" size="lg" />}>{t("Close", "关闭")}</DialogClose>
          <Button variant="primary" size="lg" disabled={!cer || complete.isPending} onClick={() => complete.mutate()}>
            {t("Add certificate", "添加证书")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
