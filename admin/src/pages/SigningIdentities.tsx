/**
 * Organization › Signing — signing keys and certificates held by Hands.
 *
 * Android keys can be generated here (the private key is created inside Hands)
 * or uploaded. Apple keys can be made here too: for iOS, App Store Connect
 * issues the Distribution certificate directly (Admin API key); for macOS
 * Developer ID, which only the Account Holder can create on the Apple
 * Developer site, Hands gives a certificate request to take there and takes
 * the issued .cer back. Existing .p12 files can still be uploaded with
 * step-by-step guidance. An App Store Connect API key can be copied from an
 * app here that already has one. Each identity is granted to the apps that
 * may sign with it; CI then runs `hands sign`.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelSigningCertificateRequest,
  completeSigningCertificateRequest,
  createSigningCertificateRequest,
  exportSigningIdentityBackup,
  generateAndroidSigningIdentity,
  generateAppleIosSigningIdentity,
  listSigningCertificateRequests,
  grantSigningIdentity,
  listApps,
  listSigningApiKeySources,
  listSigningIdentities,
  revokeSigningIdentity,
  ungrantSigningIdentity,
  uploadSigningIdentity,
  type SigningCertificateRequest,
  type SigningIdentity,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useText } from "../lib/locale";
import { useToast } from "../components/Toast";
import { TextLink, Button, EmptyState, EmptyStateTitle, Input, Label, Skeleton } from "@botiverse/raft-ui";

const KIND_LABEL: Record<SigningIdentity["kind"], [string, string]> = {
  android_keystore: ["Android key", "安卓签名密钥"],
  apple_developer_id: ["Apple Developer ID", "Apple Developer ID"],
  apple_ios_distribution: ["Apple Distribution (iOS)", "Apple 分发证书（iOS）"],
};

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function download(name: string, bytes: Uint8Array | string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking right after click() can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function SigningTab({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<"none" | "generate" | "android" | "apple" | "ios" | "new-ios" | "new-mac">("none");
  const key = ["signing-identities", orgId];
  const identities = useQuery({ queryKey: key, queryFn: () => listSigningIdentities(orgId), enabled: canManage });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const done = (title: string) => {
    toast.show({ kind: "success", title });
    setMode("none");
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["signing-certificate-requests", orgId] });
  };
  const onError = (title: string) => (e: unknown) => toast.show({ kind: "error", title, description: errorMessage(e) });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSigningIdentity(orgId, id),
    onSuccess: () => done(t("Signing identity revoked", "签名身份已撤销")),
    onError: onError(t("Revoke failed", "撤销失败")),
  });
  const grant = useMutation({
    mutationFn: ({ id, appId, on }: { id: string; appId: string; on: boolean }) =>
      on ? grantSigningIdentity(orgId, id, appId) : ungrantSigningIdentity(orgId, id, appId),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: onError(t("Update failed", "更新失败")),
  });
  const backup = useMutation({
    mutationFn: (identity: SigningIdentity) => exportSigningIdentityBackup(orgId, identity.id).then((res) => ({ res, identity })),
    onSuccess: ({ res, identity }) => {
      // One file holding the keystore and its passwords, so nothing is half-delivered.
      const base = identity.name.replace(/[^A-Za-z0-9._-]+/g, "-");
      download(`${base}.hands-key-backup.json`, `${JSON.stringify({
        format: "PKCS12 keystore, base64",
        keystore_b64: res.keystore_b64,
        key_alias: res.key_alias,
        store_password: res.store_password,
        key_password: res.key_password,
        restore: "Decode keystore_b64 from base64 into a .p12 file; open it with store_password.",
      }, null, 2)}\n`);
      backup.reset();
      toast.show({ kind: "success", title: t("Backup downloaded. Store it offline; if it did not arrive, retry within 10 minutes.", "备份已下载。请离线保存；如果没有收到，10 分钟内可以重试。") });
      qc.invalidateQueries({ queryKey: key });
    },
    onError: onError(t("Backup failed", "备份失败")),
  });

  if (!canManage) {
    return <p className="text-sm text-foreground-muted">{t("Only organization admins manage signing identities.", "只有组织管理员可以管理签名身份。")}</p>;
  }
  const orgApps = (apps.data?.apps ?? []).filter((a) => a.org_id === orgId);
  const rows = identities.data?.signing_identities ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setMode("generate")}>{t("New Android key", "新建安卓签名密钥")}</Button>
        <Button variant="outline" onClick={() => setMode("android")}>{t("Upload Android keystore", "上传安卓 keystore")}</Button>
        <Button variant="outline" onClick={() => setMode("new-ios")}>{t("New Apple Distribution certificate (iOS)", "新建 Apple 分发证书（iOS）")}</Button>
        <Button variant="outline" onClick={() => setMode("new-mac")}>{t("New Developer ID certificate (macOS)", "新建 Developer ID 证书（macOS）")}</Button>
        <Button variant="outline" onClick={() => setMode("apple")}>{t("Upload Apple Developer ID (macOS)", "上传 Apple Developer ID（macOS）")}</Button>
        <Button variant="outline" onClick={() => setMode("ios")}>{t("Upload Apple Distribution (iOS)", "上传 Apple 分发证书（iOS）")}</Button>
      </div>
      {mode === "new-ios" && <NewAppleForm key="new-ios" orgId={orgId} kind="apple_ios_distribution" onIdentity={() => done(t("Certificate created", "证书已创建"))} onRequest={() => done(t("Request created: download it below", "请求已创建：在下方下载"))} onCancel={() => setMode("none")} />}
      {mode === "new-mac" && <NewAppleForm key="new-mac" orgId={orgId} kind="apple_developer_id" onIdentity={() => done(t("Certificate created", "证书已创建"))} onRequest={() => done(t("Request created: download it below", "请求已创建：在下方下载"))} onCancel={() => setMode("none")} />}
      <PendingRequests orgId={orgId} onCompleted={() => done(t("Certificate added", "证书已添加"))} />
      {mode === "generate" && <GenerateForm orgId={orgId} onDone={() => done(t("Android key created", "安卓签名密钥已创建"))} onCancel={() => setMode("none")} />}
      {mode === "android" && <AndroidUploadForm orgId={orgId} onDone={() => done(t("Keystore uploaded", "keystore 已上传"))} onCancel={() => setMode("none")} />}
      {mode === "apple" && <AppleUploadForm key="apple" orgId={orgId} kind="apple_developer_id" onDone={() => done(t("Certificate uploaded", "证书已上传"))} onCancel={() => setMode("none")} />}
      {mode === "ios" && <AppleUploadForm key="ios" orgId={orgId} kind="apple_ios_distribution" onDone={() => done(t("Certificate uploaded", "证书已上传"))} onCancel={() => setMode("none")} />}

      {identities.isLoading && <Skeleton className="h-10 w-full" />}
      {identities.error && <p className="text-danger">{errorMessage(identities.error)}</p>}
      {identities.data && rows.length === 0 && (
        <EmptyState><EmptyStateTitle>{t("No signing identities yet.", "暂无签名身份。")}</EmptyStateTitle></EmptyState>
      )}
      {rows.map((identity) => (
        <div key={identity.id} className="rounded border border-line-hairline p-3 text-sm space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-medium">{identity.name}</div>
              <div className="text-xs text-foreground-muted">
                {t(KIND_LABEL[identity.kind][0], KIND_LABEL[identity.kind][1])}
                {" · "}{identity.origin === "generated" ? t("generated in Hands", "在 Hands 中生成") : t("uploaded", "已上传")}
                {identity.metadata.not_after ? <ExpiryNote notAfter={identity.metadata.not_after} /> : null}
                {identity.metadata.team_id ? ` · team ${identity.metadata.team_id}` : ""}
                {identity.kind === "apple_developer_id" ? ` · ${identity.metadata.notary_key_id ? t("notarization on", "已配置公证") : t("no notarization key", "未配置公证")}` : ""}
                {identity.kind === "apple_ios_distribution" ? ` · ${identity.metadata.asc_key_id ? t("profiles managed by Hands", "描述文件由 Hands 管理") : t(`${identity.metadata.provisioning_profile_count ?? 0} uploaded profile(s)`, `已上传 ${identity.metadata.provisioning_profile_count ?? 0} 个描述文件`)}` : ""}
                {identity.metadata.api_key_from_app ? ` · ${t(`API key from ${identity.metadata.api_key_from_app}`, `API key 来自 ${identity.metadata.api_key_from_app}`)}` : ""}
              </div>
              <div className="font-mono text-xs text-foreground-muted break-all">SHA-256 {identity.metadata.sha256_fingerprint ?? "—"}</div>
              {identity.metadata.subject && <div className="text-xs text-foreground-muted">{identity.metadata.subject}</div>}
            </div>
            <div className="flex gap-2">
              {identity.origin === "generated" && (identity.backup_exported_at === null || identity.backup_exported_at > Date.now() - 10 * 60 * 1000) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={backup.isPending}
                  onClick={() => {
                    if (confirm(t("Download the one-time backup? It can only be downloaded once.", "下载一次性备份？只能下载一次。"))) backup.mutate(identity);
                  }}
                >
                  {t("Download backup (once)", "下载备份（仅一次）")}
                </Button>
              )}
              <TextLink
                className="text-danger"
                disabled={revoke.isPending}
                onClick={() => {
                  if (confirm(t(`Revoke ${identity.name}? Apps can no longer sign with it.`, `撤销 ${identity.name}？之后应用不能再用它签名。`))) revoke.mutate(identity.id);
                }}
              >
                {t("Revoke", "撤销")}
              </TextLink>
            </div>
          </div>
          <div>
            <div className="text-xs text-foreground-muted mb-1">{t("Apps that may sign with it", "可以用它签名的应用")}</div>
            <div className="flex flex-wrap gap-3">
              {orgApps.map((app) => {
                const on = identity.apps.some((a) => a.app_id === app.id);
                return (
                  <label key={app.id} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={grant.isPending}
                      onChange={(e) => grant.mutate({ id: identity.id, appId: app.id, on: e.target.checked })}
                    />
                    {app.slug}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      ))}
      <p className="text-xs text-foreground-muted">
        {t(
          "Keys are encrypted in Hands and never sent to CI. A granted app signs with `hands sign <file> --app <app>` (macOS: add --notarize).",
          "密钥加密保存在 Hands，不会发给 CI。被授权的应用用 `hands sign <文件> --app <应用>` 签名（macOS 加 --notarize）。",
        )}
      </p>
    </section>
  );
}

function FormShell({ children, onSubmit, onCancel, pending }: { children: React.ReactNode; onSubmit: () => void; onCancel: () => void; pending: boolean }) {
  const t = useText();
  return (
    <form className="grid gap-3 rounded border border-line-hairline p-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {children}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>{t("Save", "保存")}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>{t("Cancel", "取消")}</Button>
      </div>
    </form>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label htmlFor={id}>{label}</Label>{children}</div>;
}

function GenerateForm({ orgId, onDone, onCancel }: { orgId: string; onDone: () => void; onCancel: () => void }) {
  const t = useText();
  const toast = useToast();
  const [name, setName] = useState("");
  const [cn, setCn] = useState("");
  const [org, setOrg] = useState("");
  const m = useMutation({
    mutationFn: () => generateAndroidSigningIdentity(orgId, { name: name.trim(), ...(cn ? { common_name: cn } : {}), ...(org ? { organization: org } : {}) }),
    onSuccess: onDone,
    onError: (e) => toast.show({ kind: "error", title: t("Create failed", "创建失败"), description: errorMessage(e) }),
  });
  return (
    <FormShell onSubmit={() => m.mutate()} onCancel={onCancel} pending={m.isPending}>
      <Field id="sg-name" label={t("Name", "名称")}><Input id="sg-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field id="sg-cn" label={t("Certificate name (CN)", "证书名称（CN）")}><Input id="sg-cn" value={cn} onChange={(e) => setCn(e.target.value)} /></Field>
      <Field id="sg-org" label={t("Organization (O)", "组织（O）")}><Input id="sg-org" value={org} onChange={(e) => setOrg(e.target.value)} /></Field>
      <p className="text-xs text-foreground-muted sm:col-span-2">
        {t("RSA 4096, valid for 30 years. The private key is created inside Hands; you can download one backup afterwards.", "RSA 4096，有效期 30 年。私钥在 Hands 内生成；之后可以下载一次备份。")}
      </p>
    </FormShell>
  );
}

function AndroidUploadForm({ orgId, onDone, onCancel }: { orgId: string; onDone: () => void; onCancel: () => void }) {
  const t = useText();
  const toast = useToast();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [storePassword, setStorePassword] = useState("");
  const [alias, setAlias] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const m = useMutation({
    mutationFn: async () => uploadSigningIdentity(orgId, {
      kind: "android_keystore", name: name.trim(), keystore_b64: await fileBase64(file!),
      store_password: storePassword, key_alias: alias.trim(), ...(keyPassword ? { key_password: keyPassword } : {}),
    }),
    onSuccess: onDone,
    onError: (e) => toast.show({ kind: "error", title: t("Upload failed", "上传失败"), description: errorMessage(e) }),
  });
  return (
    <FormShell onSubmit={() => m.mutate()} onCancel={onCancel} pending={m.isPending || !file}>
      <Field id="sa-name" label={t("Name", "名称")}><Input id="sa-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field id="sa-file" label={t("Keystore (.p12 / PKCS12)", "Keystore（.p12 / PKCS12）")}><input id="sa-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
      <Field id="sa-pass" label={t("Store password", "Store 密码")}><Input id="sa-pass" type="password" value={storePassword} onChange={(e) => setStorePassword(e.target.value)} required /></Field>
      <Field id="sa-alias" label={t("Key alias", "Key alias")}><Input id="sa-alias" value={alias} onChange={(e) => setAlias(e.target.value)} required /></Field>
      <Field id="sa-kpass" label={t("Key password (if different)", "Key 密码（如不同）")}><Input id="sa-kpass" type="password" value={keyPassword} onChange={(e) => setKeyPassword(e.target.value)} /></Field>
    </FormShell>
  );
}

type AppleKind = "apple_developer_id" | "apple_ios_distribution";

const APPLE_LINKS = {
  certificates: "https://developer.apple.com/account/resources/certificates/add",
  identifiers: "https://developer.apple.com/account/resources/identifiers/list",
  profiles: "https://developer.apple.com/account/resources/profiles/add",
  apiKeys: "https://appstoreconnect.apple.com/access/integrations/api",
  csr: "https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request",
};

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="underline" href={href} target="_blank" rel="noreferrer">{children}</a>;
}

/** Where each file comes from, in the order an admin does it. */
function AppleSteps({ kind }: { kind: AppleKind }) {
  const t = useText();
  const certName = kind === "apple_developer_id" ? "Developer ID Application" : "Apple Distribution";
  return (
    <div className="sm:col-span-2 rounded bg-layer-inset p-3 text-xs space-y-2">
      <div className="font-medium">{t("How to get these files", "这些文件从哪里来")}</div>
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          {t("On a Mac, create a certificate signing request: ", "在 Mac 上创建证书签名请求：")}
          {t("Keychain Access › Certificate Assistant › Request a Certificate From a Certificate Authority, saved to disk. ", "钥匙串访问 › 证书助理 › 从证书颁发机构请求证书，存储到磁盘。")}
          <ExternalLink href={APPLE_LINKS.csr}>{t("Apple's guide", "Apple 说明")}</ExternalLink>
        </li>
        <li>
          {t(`In the Apple Developer site, create a "${certName}" certificate from that request and download the .cer file. `, `在 Apple Developer 网站用这个请求创建“${certName}”证书，下载 .cer 文件。`)}
          {kind === "apple_developer_id" && t("Only the Account Holder can create Developer ID certificates. ", "只有 Account Holder 能创建 Developer ID 证书。")}
          <ExternalLink href={APPLE_LINKS.certificates}>{t("Certificates", "证书")}</ExternalLink>
        </li>
        <li>
          {t(`Double-click the .cer to add it to Keychain Access. Under My Certificates, right-click "${certName}: …", choose Export, save as .p12 and set a password.`, `双击 .cer 加入钥匙串访问。在“我的证书”里右键“${certName}: …”，选择导出，存为 .p12 并设置密码。`)}
        </li>
        {kind === "apple_developer_id" ? (
          <li>
            {t("For notarization, use the App Store Connect API key an app here already has, or create a Team key with the Developer role and download its .p8 (it can be downloaded only once). ", "公证需要 App Store Connect API key：可以直接用这里某个应用已有的 key，或者新建一个 Developer 权限的 Team key 并下载 .p8（只能下载一次）。")}
            <ExternalLink href={APPLE_LINKS.apiKeys}>{t("API keys", "API key")}</ExternalLink>
          </li>
        ) : (
          <>
            <li>
              {t("Make sure the app's bundle ID exists as an App ID with the capabilities the app uses, such as Associated Domains. ", "确认应用的 bundle ID 已经注册为 App ID，并打开应用用到的能力，比如 Associated Domains。")}
              <ExternalLink href={APPLE_LINKS.identifiers}>{t("Identifiers", "标识符")}</ExternalLink>
            </li>
            <li>
              {t("With an App Store Connect API key (App Manager or Admin role), Hands creates and renews the App Store provisioning profile itself. Without one, create an App Store profile and upload the .mobileprovision here. ", "有 App Store Connect API key（App Manager 或 Admin 权限）时，Hands 自己创建和续期 App Store 描述文件。没有的话，先创建 App Store 描述文件，把 .mobileprovision 传到这里。")}
              <ExternalLink href={APPLE_LINKS.profiles}>{t("Profiles", "描述文件")}</ExternalLink>
            </li>
          </>
        )}
      </ol>
    </div>
  );
}

type KeyChoice = { mode: "app"; appId: string } | { mode: "new" } | { mode: "none" };

function ApiKeyPicker({ orgId, kind, choice, onChange, keyId, setKeyId, issuerId, setIssuerId, setP8, allowNone = true }: {
  orgId: string; kind: AppleKind; choice: KeyChoice; onChange: (c: KeyChoice) => void; allowNone?: boolean;
  keyId: string; setKeyId: (v: string) => void; issuerId: string; setIssuerId: (v: string) => void; setP8: (f: File | null) => void;
}) {
  const t = useText();
  const sources = useQuery({ queryKey: ["signing-api-keys", orgId], queryFn: () => listSigningApiKeySources(orgId) });
  const keys = sources.data?.api_keys ?? [];
  const label = kind === "apple_developer_id"
    ? t("App Store Connect API key for notarization", "公证用的 App Store Connect API key")
    : t("App Store Connect API key for provisioning profiles", "管理描述文件用的 App Store Connect API key");
  return (
    <fieldset className="sm:col-span-2 space-y-2 text-sm">
      <legend className="text-xs text-foreground-muted">{label}</legend>
      {keys.map((k) => (
        <label key={k.app_id} className="flex items-center gap-2">
          <input type="radio" name="api-key" checked={choice.mode === "app" && choice.appId === k.app_id} onChange={() => onChange({ mode: "app", appId: k.app_id })} />
          {t(`Use the key of ${k.slug} (Key ID ${k.key_id})`, `使用 ${k.slug} 的 key（Key ID ${k.key_id}）`)}
        </label>
      ))}
      <label className="flex items-center gap-2">
        <input type="radio" name="api-key" checked={choice.mode === "new"} onChange={() => onChange({ mode: "new" })} />
        {t("Enter a new key", "填写新的 key")}
      </label>
      {allowNone && (
        <label className="flex items-center gap-2">
          <input type="radio" name="api-key" checked={choice.mode === "none"} onChange={() => onChange({ mode: "none" })} />
          {kind === "apple_developer_id" ? t("No notarization", "不公证") : t("No key: I upload a provisioning profile", "不用 key：我自己上传描述文件")}
        </label>
      )}
      {choice.mode === "new" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="ap-key" label="Key ID"><Input id="ap-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} required /></Field>
          <Field id="ap-iss" label="Issuer ID"><Input id="ap-iss" value={issuerId} onChange={(e) => setIssuerId(e.target.value)} required /></Field>
          <Field id="ap-p8" label="AuthKey_XXXX.p8"><input id="ap-p8" type="file" accept=".p8" onChange={(e) => setP8(e.target.files?.[0] ?? null)} required /></Field>
        </div>
      )}
    </fieldset>
  );
}

function AppleUploadForm({ orgId, kind, onDone, onCancel }: { orgId: string; kind: AppleKind; onDone: () => void; onCancel: () => void }) {
  const t = useText();
  const toast = useToast();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [choice, setChoice] = useState<KeyChoice>({ mode: "none" });
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [p8, setP8] = useState<File | null>(null);
  const [profiles, setProfiles] = useState<File[]>([]);
  const ios = kind === "apple_ios_distribution";
  const m = useMutation({
    mutationFn: async () => {
      const key = choice.mode === "app"
        ? { from_app: choice.appId }
        : choice.mode === "new" && p8 ? { key_id: keyId.trim(), issuer_id: issuerId.trim(), p8: await p8.text() } : null;
      return uploadSigningIdentity(orgId, {
        kind, name: name.trim(), p12_b64: await fileBase64(file!), p12_password: password,
        ...(ios
          ? { asc: key, provisioning_profiles_b64: await Promise.all(profiles.map(fileBase64)) }
          : { notary: key }),
      });
    },
    onSuccess: onDone,
    onError: (e) => toast.show({ kind: "error", title: t("Upload failed", "上传失败"), description: errorMessage(e) }),
  });
  const certLabel = ios ? t("Apple Distribution certificate (.p12)", "Apple Distribution 证书（.p12）") : t("Developer ID Application certificate (.p12)", "Developer ID Application 证书（.p12）");
  const missing = !file || (choice.mode === "new" && !p8) || (ios && choice.mode === "none" && profiles.length === 0);
  return (
    <FormShell onSubmit={() => m.mutate()} onCancel={onCancel} pending={m.isPending || missing}>
      <p className="sm:col-span-2 text-xs text-foreground-muted">
        {ios
          ? t("No .p12 yet? \"New Apple Distribution certificate\" makes one in Hands without Keychain Access.", "还没有 .p12？用“新建 Apple 分发证书”可以直接在 Hands 里生成，不用钥匙串。")
          : t("No .p12 yet? \"New Developer ID certificate\" makes the key in Hands; you only upload a request file to Apple and the .cer back.", "还没有 .p12？用“新建 Developer ID 证书”在 Hands 里生成密钥；你只需要把请求文件传给 Apple，再把 .cer 传回来。")}
      </p>
      <AppleSteps kind={kind} />
      <Field id="ap-name" label={t("Name", "名称")}><Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field id="ap-file" label={certLabel}><input id="ap-file" type="file" accept=".p12,.pfx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
      <Field id="ap-pass" label={t(".p12 password", ".p12 密码")}><Input id="ap-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ApiKeyPicker orgId={orgId} kind={kind} choice={choice} onChange={setChoice} keyId={keyId} setKeyId={setKeyId} issuerId={issuerId} setIssuerId={setIssuerId} setP8={setP8} />
      {ios && (
        <Field id="ap-profiles" label={choice.mode === "none" ? t("Provisioning profile (.mobileprovision)", "描述文件（.mobileprovision）") : t("Provisioning profile (optional)", "描述文件（可选）")}>
          <input id="ap-profiles" type="file" accept=".mobileprovision" multiple onChange={(e) => setProfiles(Array.from(e.target.files ?? []))} />
        </Field>
      )}
    </FormShell>
  );
}

/** Expiry date, flagged when the certificate runs out within 30 days. */
function ExpiryNote({ notAfter }: { notAfter: string }) {
  const t = useText();
  const at = Date.parse(notAfter);
  const soon = Number.isFinite(at) && at - Date.now() < 30 * 24 * 60 * 60 * 1000;
  if (!soon) return <>{` · ${t("expires", "到期")} ${notAfter}`}</>;
  return (
    <span className="text-danger">
      {` · ${at < Date.now() ? t("expired", "已过期") : t("expires soon", "即将到期")} ${notAfter} — ${t("make a new certificate and grant it to the apps", "请新建证书并授权给应用")}`}
    </span>
  );
}

/**
 * Make an Apple key in Hands. iOS can go straight through App Store Connect
 * (Admin key); otherwise, and always for Developer ID, Hands gives a
 * certificate request to take to the Apple Developer site.
 */
function NewAppleForm({ orgId, kind, onIdentity, onRequest, onCancel }: {
  orgId: string; kind: AppleKind; onIdentity: () => void; onRequest: () => void; onCancel: () => void;
}) {
  const t = useText();
  const toast = useToast();
  const ios = kind === "apple_ios_distribution";
  const [name, setName] = useState("");
  const [direct, setDirect] = useState(ios);
  const [choice, setChoice] = useState<KeyChoice>(ios ? { mode: "new" } : { mode: "none" });
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [p8, setP8] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const key = choice.mode === "app"
        ? { from_app: choice.appId }
        : choice.mode === "new" && p8 ? { key_id: keyId.trim(), issuer_id: issuerId.trim(), p8: await p8.text() } : null;
      if (ios && direct) return { identity: await generateAppleIosSigningIdentity(orgId, { name: name.trim(), asc: key ?? {} }) };
      return { request: await createSigningCertificateRequest(orgId, { kind, name: name.trim(), ...(ios ? { asc: key } : { notary: key }) }) };
    },
    onSuccess: (res) => ("identity" in res ? onIdentity() : onRequest()),
    onError: (e) => toast.show({ kind: "error", title: t("Create failed", "创建失败"), description: errorMessage(e) }),
  });
  const missing = (choice.mode === "new" && !p8) || (ios && choice.mode === "none");
  return (
    <FormShell onSubmit={() => m.mutate()} onCancel={onCancel} pending={m.isPending || missing}>
      <div className="sm:col-span-2 rounded bg-layer-inset p-3 text-xs space-y-2">
        <div className="font-medium">{t("The private key is created inside Hands and never leaves it.", "私钥在 Hands 内生成，不会离开 Hands。")}</div>
        {ios ? (
          <>
            <label className="flex items-center gap-2">
              <input type="radio" name="ios-route" checked={direct} onChange={() => setDirect(true)} />
              {t("Hands asks Apple for the certificate (API key with the Admin role)", "Hands 直接向 Apple 申请证书（需要 Admin 角色的 API key）")}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="ios-route" checked={!direct} onChange={() => setDirect(false)} />
              {t("I take a request file to the Apple Developer site (any key role)", "我把请求文件拿到 Apple Developer 网站申请（key 任何角色都行）")}
            </label>
            <p>
              {t("Apple allows a team only a few Distribution certificates; if it refuses, revoke an unused one first. ", "Apple 每个团队只能有少量 Distribution 证书；如果被拒，先撤销一张不用的。")}
              <ExternalLink href={APPLE_LINKS.certificates.replace("/add", "/list")}>{t("Certificates", "证书")}</ExternalLink>
            </p>
          </>
        ) : (
          <p>
            {t("Apple lets only the Account Holder create Developer ID certificates, on the Apple Developer site. After saving, download the request below, create a \"Developer ID Application\" certificate from it there, and upload the .cer here.", "Apple 只允许 Account Holder 在 Apple Developer 网站创建 Developer ID 证书。保存后在下方下载请求文件，到网站上用它创建“Developer ID Application”证书，再把 .cer 传回这里。")}
          </p>
        )}
      </div>
      <Field id="na-name" label={t("Name", "名称")}><Input id="na-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <ApiKeyPicker
        orgId={orgId} kind={kind} choice={choice} onChange={setChoice} allowNone={!ios}
        keyId={keyId} setKeyId={setKeyId} issuerId={issuerId} setIssuerId={setIssuerId} setP8={setP8}
      />
    </FormShell>
  );
}

/** Requests waiting for the certificate Apple issues: download, take to Apple, upload the .cer. */
function PendingRequests({ orgId, onCompleted }: { orgId: string; onCompleted: () => void }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["signing-certificate-requests", orgId];
  const requests = useQuery({ queryKey: key, queryFn: () => listSigningCertificateRequests(orgId) });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelSigningCertificateRequest(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.show({ kind: "error", title: t("Cancel failed", "取消失败"), description: errorMessage(e) }),
  });
  const rows = requests.data?.certificate_requests ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <PendingRequest key={r.id} orgId={orgId} request={r} onCompleted={onCompleted} onCancel={() => {
          if (confirm(t(`Cancel the request ${r.name}? Its key is deleted.`, `取消请求 ${r.name}？它的密钥会被删除。`))) cancel.mutate(r.id);
        }} />
      ))}
    </div>
  );
}

function PendingRequest({ orgId, request, onCompleted, onCancel }: {
  orgId: string; request: SigningCertificateRequest; onCompleted: () => void; onCancel: () => void;
}) {
  const t = useText();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const certName = request.kind === "apple_developer_id" ? "Developer ID Application" : "Apple Distribution";
  const m = useMutation({
    mutationFn: async () => completeSigningCertificateRequest(orgId, request.id, await fileBase64(file!)),
    onSuccess: onCompleted,
    onError: (e) => toast.show({ kind: "error", title: t("Upload failed", "上传失败"), description: errorMessage(e) }),
  });
  const base = request.name.replace(/[^A-Za-z0-9._-]+/g, "-");
  return (
    <form
      className="rounded border border-line-hairline p-3 text-sm space-y-2"
      aria-label={request.name}
      onSubmit={(e) => { e.preventDefault(); if (file) m.mutate(); }}
    >
      <div className="font-medium">{request.name} · {t("waiting for Apple's certificate", "等待 Apple 证书")}</div>
      <ol className="list-decimal space-y-1 pl-4 text-xs">
        <li>
          <TextLink type="button" className="h-auto p-0" onClick={() => download(`${base}.certSigningRequest`, request.csr_pem)}>
            {t("Download the request (.certSigningRequest)", "下载请求文件（.certSigningRequest）")}
          </TextLink>
        </li>
        <li>
          {t(`On the Apple Developer site, create a "${certName}" certificate, upload this request, and download the .cer. `, `在 Apple Developer 网站创建“${certName}”证书，上传这个请求文件，下载 .cer。`)}
          <ExternalLink href={APPLE_LINKS.certificates}>{t("Certificates", "证书")}</ExternalLink>
        </li>
        <li>
          <label className="inline-flex flex-wrap items-center gap-2">
            {t("Upload the .cer here:", "把 .cer 传到这里：")}
            <input type="file" accept=".cer,.crt,.pem" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </li>
      </ol>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!file || m.isPending}>{t("Add certificate", "添加证书")}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{t("Cancel request", "取消请求")}</Button>
      </div>
    </form>
  );
}
