/**
 * Organization › Signing — signing keys and certificates held by Hands.
 *
 * Android keys can be generated here (the private key is created inside Hands)
 * or uploaded; Apple Developer ID certificates are uploaded with an optional
 * App Store Connect API key for notarization. Each identity is granted to the
 * apps that may sign with it; CI then runs `hands sign`.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  exportSigningIdentityBackup,
  generateAndroidSigningIdentity,
  grantSigningIdentity,
  listApps,
  listSigningIdentities,
  revokeSigningIdentity,
  ungrantSigningIdentity,
  uploadSigningIdentity,
  type SigningIdentity,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useText } from "../lib/locale";
import { useToast } from "../components/Toast";
import { Button, EmptyState, EmptyStateTitle, Input, Label, Skeleton } from "raft-ui";

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
  const [mode, setMode] = useState<"none" | "generate" | "android" | "apple">("none");
  const key = ["signing-identities", orgId];
  const identities = useQuery({ queryKey: key, queryFn: () => listSigningIdentities(orgId), enabled: canManage });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const done = (title: string) => {
    toast.show({ kind: "success", title });
    setMode("none");
    qc.invalidateQueries({ queryKey: key });
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
        <Button variant="outline" onClick={() => setMode("apple")}>{t("Upload Apple Developer ID", "上传 Apple Developer ID")}</Button>
      </div>
      {mode === "generate" && <GenerateForm orgId={orgId} onDone={() => done(t("Android key created", "安卓签名密钥已创建"))} onCancel={() => setMode("none")} />}
      {mode === "android" && <AndroidUploadForm orgId={orgId} onDone={() => done(t("Keystore uploaded", "keystore 已上传"))} onCancel={() => setMode("none")} />}
      {mode === "apple" && <AppleUploadForm orgId={orgId} onDone={() => done(t("Certificate uploaded", "证书已上传"))} onCancel={() => setMode("none")} />}

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
                {identity.metadata.not_after ? ` · ${t("expires", "到期")} ${identity.metadata.not_after}` : ""}
                {identity.metadata.team_id ? ` · team ${identity.metadata.team_id}` : ""}
                {identity.kind === "apple_developer_id" ? ` · ${identity.metadata.notary_key_id ? t("notarization on", "已配置公证") : t("no notarization key", "未配置公证")}` : ""}
              </div>
              <div className="font-mono text-xs text-foreground-muted break-all">SHA-256 {identity.metadata.sha256_fingerprint ?? "—"}</div>
              {identity.metadata.subject && <div className="text-xs text-foreground-muted">{identity.metadata.subject}</div>}
            </div>
            <div className="flex gap-2">
              {identity.origin === "generated" && identity.backup_exported_at === null && (
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
              <Button
                variant="link"
                size="sm"
                className="text-danger"
                disabled={revoke.isPending}
                onClick={() => {
                  if (confirm(t(`Revoke ${identity.name}? Apps can no longer sign with it.`, `撤销 ${identity.name}？之后应用不能再用它签名。`))) revoke.mutate(identity.id);
                }}
              >
                {t("Revoke", "撤销")}
              </Button>
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

function AppleUploadForm({ orgId, onDone, onCancel }: { orgId: string; onDone: () => void; onCancel: () => void }) {
  const t = useText();
  const toast = useToast();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [p8, setP8] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => uploadSigningIdentity(orgId, {
      kind: "apple_developer_id", name: name.trim(), p12_b64: await fileBase64(file!), p12_password: password,
      notary: keyId && issuerId && p8 ? { key_id: keyId.trim(), issuer_id: issuerId.trim(), p8: await p8.text() } : null,
    }),
    onSuccess: onDone,
    onError: (e) => toast.show({ kind: "error", title: t("Upload failed", "上传失败"), description: errorMessage(e) }),
  });
  return (
    <FormShell onSubmit={() => m.mutate()} onCancel={onCancel} pending={m.isPending || !file}>
      <Field id="ap-name" label={t("Name", "名称")}><Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field id="ap-file" label={t("Developer ID Application certificate (.p12)", "Developer ID Application 证书（.p12）")}><input id="ap-file" type="file" accept=".p12,.pfx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
      <Field id="ap-pass" label={t(".p12 password", ".p12 密码")}><Input id="ap-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <div className="sm:col-span-2 text-xs text-foreground-muted">{t("Notarization (App Store Connect API key, Developer role):", "公证（App Store Connect API key，Developer 权限）：")}</div>
      <Field id="ap-key" label="Key ID"><Input id="ap-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} /></Field>
      <Field id="ap-iss" label="Issuer ID"><Input id="ap-iss" value={issuerId} onChange={(e) => setIssuerId(e.target.value)} /></Field>
      <Field id="ap-p8" label="AuthKey_XXXX.p8"><input id="ap-p8" type="file" accept=".p8" onChange={(e) => setP8(e.target.files?.[0] ?? null)} /></Field>
    </FormShell>
  );
}
