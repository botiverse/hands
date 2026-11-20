import { errorMessage } from "../../lib/errorMessage";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRowGroup,
  Select,
  SelectContent,
  SelectList,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  TextLink,
  TextLinkExternalIcon,
} from "@botiverse/raft-ui";
import {
  deleteGooglePlayBinding,
  getGooglePlayBinding,
  listBuilds,
  listChannels,
  listGooglePlayTracks,
  setGooglePlayBinding,
  setGooglePlayBindingEnabled,
  deleteGooglePlayReportsGrant,
  ApiError,
  startGooglePlayOAuth,
  verifyGooglePlayBinding,
} from "../../lib/api";
import { googlePlayPackageOptions } from "../../lib/googlePlayPackages";
import { googlePlayMessage as gp, googlePlayOAuthFailureMessage } from "../../lib/googlePlayMessages";
import { useToast } from "../Toast";
import { useText } from "../../lib/locale";
import { DetailSection } from "../ListPage";
import { DangerRow, FormActions, SettingRow, type ConnectorState } from "./ConnectorParts";

/** The state of an app's Google Play connection, for its row in the list.
 *  Reads the same query the connector does. */
export function useGooglePlayState(appId: string, enabled = true): ConnectorState | undefined {
  const t = useText();
  const query = useQuery({ queryKey: ["google-play-binding", appId], queryFn: () => getGooglePlayBinding(appId), enabled });
  if (!query.data) return undefined;
  const meta = query.data.google_play;
  if (!meta) return { tone: "off", label: t("Not connected", "未连接") };
  if (!meta.package_name) return { tone: "attention", label: t("Needs attention", "需要处理"), detail: gp("needsConfig") };
  if (meta.verification_state !== "verified") return { tone: "attention", label: t("Needs attention", "需要处理"), detail: `${meta.package_name} · ${gp("stale")}` };
  if (!meta.enabled) return { tone: "paused", label: gp("disabled"), detail: meta.package_name };
  const reports = query.data.reports_grant ? "" : ` · ${t("statistics not authorized", "统计未授权")}`;
  return { tone: "connected", label: gp("connected"), detail: `${meta.package_name}${reports}` };
}

export function GooglePlayConnector({ appId }: { appId: string }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["google-play-binding", appId], queryFn: () => getGooglePlayBinding(appId) });
  const meta = query.data?.google_play ?? null;
  const reportsGrant = query.data?.reports_grant ?? null;
  const [editing, setEditing] = useState(false);
  const [credentialJson, setCredentialJson] = useState("");
  const [connectionMethod, setConnectionMethod] = useState<"google" | "service">("google");
  const packageChannels = useQuery({ queryKey: ["channels", appId], queryFn: () => listChannels(appId) });
  const packageBuilds = useQuery({ queryKey: ["builds", appId], queryFn: () => listBuilds(appId) });
  const packageOptions = googlePlayPackageOptions(packageChannels.data?.channels ?? [], packageBuilds.data?.builds ?? []);
  const mainPackages = packageOptions.filter((option) => option.isMain);
  const suggestedPackage = mainPackages.length === 1 ? mainPackages[0]!.packageName : "";
  const [packageName, setPackageName] = useState("");
  const [internalTrack, setInternalTrack] = useState("");
  const [closedTrack, setClosedTrack] = useState("");
  const [productionTrack, setProductionTrack] = useState("");

  useEffect(() => {
    if (!meta || editing) return;
    setPackageName(meta.package_name ?? "");
    setInternalTrack(meta.internal_track ?? "");
    setClosedTrack(meta.closed_track ?? "");
    setProductionTrack(meta.production_track ?? "");
  }, [meta, editing]);

  useEffect(() => {
    if (!meta?.package_name && suggestedPackage) {
      setPackageName((current) => current || suggestedPackage);
    }
  }, [meta, suggestedPackage]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["google-play-binding", appId] });
  const fail = (error: unknown) => toast.show({ kind: "error", title: gp("actionFailed"), description: errorMessage(error) });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google_play_oauth");
    if (!result || query.isLoading) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("google_play_oauth");
    url.searchParams.delete("google_play_oauth_error");
    url.searchParams.delete("google_play_oauth_purpose");
    window.history.replaceState(null, "", url);
    const purpose = params.get("google_play_oauth_purpose") === "reports" ? "reports" : "publishing";
    if (result === "reports_connected") {
      toast.show({ kind: "success", title: gp("reportsConnected") });
      setOauthResult(null);
    } else if (result === "connected" && meta?.credential_kind === "authorized_user") {
      toast.show({ kind: "success", title: gp("saveSuccess") });
      setOauthResult(null);
    } else if (result === "failed") {
      // Keep the failure on the row with a retry action instead of a toast
      // that disappears (artin, #proj-hands b529da37). The optional error
      // code maps to specific copy; unknown values fall back to generic.
      setOauthResult({ kind: "failed", errorCode: params.get("google_play_oauth_error"), purpose });
    } else if (result === "cancelled") {
      setOauthResult({ kind: "cancelled", purpose });
    }
  }, [query.isLoading, meta, toast]);

  const authorize = useMutation({
    mutationFn: (purpose: "publishing" | "reports" = "publishing") => startGooglePlayOAuth(appId, purpose),
    onSuccess: ({ authorization_url }) => {
      const url = new URL(authorization_url);
      if (url.origin !== "https://accounts.google.com") { fail(new Error(gp("oauthFailed"))); return; }
      window.location.assign(url.toString());
    },
    onError: fail,
  });
  const save = useMutation({
    mutationFn: () => setGooglePlayBinding(appId, {
      ...(connectionMethod === "service" ? { service_account_json: credentialJson } : {}),
      package_name: packageName.trim(),
      tracks: { internal: internalTrack.trim(), closed: closedTrack.trim(), production: productionTrack.trim() },
    }),
    onSuccess: () => {
      setCredentialJson("");
      setEditing(false);
      setTokenRejected(false);
      refresh();
      toast.show({ kind: "success", title: gp("saveSuccess") });
    },
    onError: fail,
  });
  const verify = useMutation({
    mutationFn: () => verifyGooglePlayBinding(appId),
    onSuccess: () => {
      setTokenRejected(false);
      toast.show({ kind: "success", title: gp("verifySuccess") });
    },
    onError: (error) => {
      // An expired or revoked Google grant is fixed by reauthorizing, which keeps the
      // package and tracks. Say so on the row; unbinding would delete them.
      if (reauthorizable && isTokenRejected(error)) setTokenRejected(true);
      else fail(error);
    },
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setGooglePlayBindingEnabled(appId, enabled),
    onSuccess: (_, enabled) => {
      if (enabled) setTokenRejected(false);
      toast.show({ kind: "success", title: gp(enabled ? "enableSuccess" : "disableSuccess") });
    },
    onError: fail,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteGooglePlayBinding(appId),
    onSuccess: () => {
      setEditing(false);
      setCredentialJson("");
      setPackageName("");
      setTokenRejected(false);
      refresh();
      toast.show({ kind: "success", title: gp("unbindSuccess") });
    },
    onError: fail,
  });

  let credentialLooksValid = false;
  try {
    const parsed = JSON.parse(credentialJson) as Record<string, unknown>;
    credentialLooksValid = parsed.type === "service_account" && typeof parsed.client_email === "string" && typeof parsed.private_key === "string";
  } catch {
    credentialLooksValid = false;
  }
  const [discovered, setDiscovered] = useState<{ package_name: string; tracks: string[] } | null>(null);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const [trackReload, setTrackReload] = useState(0);
  useEffect(() => {
    setDiscovered(null);
    setTracksError(null);
    const suppliedCredential = connectionMethod === "service" && (editing || !meta) ? credentialJson : undefined;
    if ((meta?.package_name && !editing) || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
      || (suppliedCredential !== undefined ? !credentialLooksValid : !meta)) { setTracksLoading(false); return; }
    let cancelled = false;
    setTracksLoading(true);
    const timer = window.setTimeout(() => {
      listGooglePlayTracks(appId, { package_name: packageName, ...(suppliedCredential === undefined ? {} : { service_account_json: suppliedCredential }) })
        .then((result) => {
          if (cancelled) return;
          setDiscovered(result);
          const ids = result.tracks;
          setInternalTrack((current) => ids.includes(current) ? current : ids.includes("internal") ? "internal" : "");
          setProductionTrack((current) => ids.includes(current) ? current : ids.includes("production") ? "production" : "");
          setClosedTrack((current) => ids.includes(current) ? current : "");
        }).catch((error) => { if (!cancelled) setTracksError((error as Error).message); })
        .finally(() => { if (!cancelled) setTracksLoading(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [appId, packageName, meta?.credential_fingerprint, meta?.package_name, credentialJson, credentialLooksValid, connectionMethod, editing, trackReload]);
  const availableTracks = discovered?.package_name === packageName ? discovered.tracks : [];
  const needsConfig = Boolean(meta && !meta.package_name);
  // Same rule as the server: an enabled Google-account binding, or one a failed
  // verification disabled, can be reauthorized in place and keeps its package and tracks.
  const reauthorizable = Boolean(meta?.credential_kind === "authorized_user" && (meta.enabled || meta.verification_state === "stale"));
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [tokenRejected, setTokenRejected] = useState(false);
  // The connector stays mounted across apps; a hint about one app's grant must not carry over.
  useEffect(() => { setTokenRejected(false); }, [appId]);
  const [oauthResult, setOauthResult] = useState<
    { kind: "failed"; errorCode: string | null; purpose: "publishing" | "reports" } | { kind: "cancelled"; purpose: "publishing" | "reports" } | null
  >(null);
  // Only a connected binding opens the detail; an unconfigured connector stays
  // a single row with Connect.
  const expanded = userExpanded ?? needsConfig;
  const tracksComplete = Boolean(
    packageName.trim() && [internalTrack, closedTrack, productionTrack].every((track) => availableTracks.includes(track)) && !tracksLoading,
  );
  // The OAuth configuration path reuses the saved credential; only the
  // service-account path must provide one.
  const credentialSatisfied = connectionMethod === "google" || credentialLooksValid;
  const formValid = credentialSatisfied && tracksComplete;

  const startConnect = () => {
    setOauthResult(null);
    setTokenRejected(false);
    authorize.mutate("publishing");
  };
  const startReports = () => {
    setOauthResult(null);
    authorize.mutate("reports");
  };
  const removeReports = useMutation({
    mutationFn: () => deleteGooglePlayReportsGrant(appId),
    onSuccess: () => { refresh(); toast.show({ kind: "success", title: gp("reportsRemoved") }); },
    onError: fail,
  });

  const confirmUnbind = () => {
    if (window.confirm(gp("confirmUnbind"))) remove.mutate();
  };
  const isManualPackage = !packageOptions.some((option) => option.packageName === packageName);

  const packageTrackFields = (
    <div className="grid gap-4">
      {packageOptions.length > 0 && (
        <Field>
          <FieldLabel htmlFor={`gp-package-${appId}`}>{gp("existingPackage")}</FieldLabel>
          <Select items={Object.fromEntries([...packageOptions.map((option) => [option.packageName, `${option.packageName} · ${gp(option.source)}`]), ["__manual__", gp("manualPackage")]])}
            value={isManualPackage ? "__manual__" : packageName}
            onValueChange={(value) => setPackageName(value === "__manual__" ? "" : String(value))}>
            <SelectTrigger id={`gp-package-${appId}`} className="w-full" aria-label={gp("existingPackage")}><SelectValue /><SelectIcon /></SelectTrigger>
            <SelectContent>
              <SelectList>
                {packageOptions.map((option) => <SelectItem key={option.packageName} value={option.packageName}>{option.packageName} · {gp(option.source)}</SelectItem>)}
                <SelectItem value="__manual__">{gp("manualPackage")}</SelectItem>
              </SelectList>
            </SelectContent>
          </Select>
        </Field>
      )}
      {isManualPackage && (
        <Field>
          <FieldLabel htmlFor={`gp-package-manual-${appId}`}>{packageOptions.length > 0 ? gp("manualPackage") : gp("packageName")}</FieldLabel>
          <Input id={`gp-package-manual-${appId}`} aria-label={packageOptions.length > 0 ? gp("packageName") : undefined} className="font-mono" value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="com.example.app" />
          {!packageName.trim() && <FieldDescription>{gp("packageMissing")}</FieldDescription>}
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Text.Sans size="small" variant="muted" className="min-w-0 flex-1">
          {tracksLoading ? gp("loadingTracks") : tracksError ? <span role="alert">{errorMessage(tracksError)}</span> : discovered && availableTracks.length === 0 ? gp("noTracks") : gp("tracksHelp")}
        </Text.Sans>
        {meta && <Button variant="outline" disabled={tracksLoading || !packageName} onClick={() => setTrackReload((n) => n + 1)}>{gp("reloadTracks")}</Button>}
      </div>
      {([
        ["internalTrack", internalTrack, setInternalTrack],
        ["closedTrack", closedTrack, setClosedTrack],
        ["productionTrack", productionTrack, setProductionTrack],
      ] as const).map(([label, value, setValue]) => (
        <Field key={label}>
          <FieldLabel htmlFor={`gp-${label}-${appId}`}>{gp(label)}</FieldLabel>
          <Select items={Object.fromEntries(availableTracks.map((id) => [id, id]))} value={availableTracks.includes(value) ? value : null} onValueChange={(id) => setValue(id ? String(id) : "")}>
            <SelectTrigger id={`gp-${label}-${appId}`} className="w-full" aria-label={gp(label)} disabled={tracksLoading || availableTracks.length === 0}><SelectValue placeholder={gp("chooseTrack")} /><SelectIcon /></SelectTrigger>
            <SelectContent>
              <SelectList>{availableTracks.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectList>
            </SelectContent>
          </Select>
        </Field>
      ))}
    </div>
  );

  const serviceCredentialField = (
    <Field>
      <FieldLabel htmlFor={`gp-credential-${appId}`}>{gp("credentialJson")}</FieldLabel>
      <input id={`gp-credential-${appId}`} className="text-callout text-foreground file:mr-3 file:rounded-control file:border file:border-line-strong file:bg-transparent file:px-3 file:py-1 file:text-foreground" type="file" accept=".json,application/json" aria-label={gp("chooseFile")} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) file.text().then(setCredentialJson, fail);
      }} />
      <FieldDescription>{credentialJson && !credentialLooksValid ? <span className="text-warning-strong">{gp("invalidJson")}</span> : gp("formHelp")}</FieldDescription>
    </Field>
  );

  const saveButton = (
    <Button variant="primary" disabled={!formValid || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>{gp("saveEnable")}</Button>
  );

  return (
    <div data-testid="google-play-binding-panel" className="flex flex-col gap-6">
      {meta && (
        <div className="flex flex-wrap items-center gap-2">
          {needsConfig ? (
            <>
              <Badge appearance="soft" variant="success">{gp("connected")}</Badge>
              <Badge appearance="soft" variant="warning">{gp("needsConfig")}</Badge>
            </>
          ) : (
            <>
              <Badge appearance={meta.enabled ? "soft" : "outline"} variant={meta.enabled ? "success" : "muted"}>{gp(meta.enabled ? "enabled" : "disabled")}</Badge>
              <Badge appearance={meta.verification_state === "verified" ? "outline" : "soft"} variant={meta.verification_state === "verified" ? "muted" : "warning"}>
                {gp(meta.verification_state === "verified" ? "verified" : "stale")}
              </Badge>
            </>
          )}
        </div>
      )}

      {tokenRejected && reauthorizable && !oauthResult ? (
        <Banner status="warning">
          <AlertTriangle aria-hidden="true" />
          <BannerDescription>{gp("tokenRejected")}</BannerDescription>
          <BannerAction>
            <Button variant="outline" disabled={authorize.isPending} onClick={startConnect}>{gp("reauthorize")}</Button>
          </BannerAction>
        </Banner>
      ) : null}
      {oauthResult ? (
        <Banner status="warning">
          <AlertTriangle aria-hidden="true" />
          <BannerDescription>
            {oauthResult.kind === "failed" ? googlePlayOAuthFailureMessage(oauthResult.errorCode) : gp("oauthCancelled")}
          </BannerDescription>
          <BannerAction>
            <Button variant="outline" onClick={oauthResult.purpose === "reports" ? startReports : startConnect}>{gp("retry")}</Button>
          </BannerAction>
        </Banner>
      ) : null}

      {!meta && !expanded && (
        <DetailSection title={t("Connect", "连接")}>
          <Text.Sans size="small" variant="muted">{gp("description")}</Text.Sans>
          <ListRowGroup>
            <SettingRow
              title={t("Sign in with Google", "使用 Google 登录")}
              description={query.isLoading || query.data?.oauth_available
                ? t("Recommended. Hands keeps the authorization encrypted; no key file is needed.", "推荐。Hands 加密保存授权，不需要密钥文件。")
                : gp("oauthUnavailable")}
            >
              <Button variant="primary" disabled={query.isLoading || authorize.isPending || !query.data?.oauth_available} onClick={startConnect}>
                {gp(authorize.isPending ? "connecting" : "connect")}
              </Button>
            </SettingRow>
            <SettingRow
              title={t("Use a key file", "使用密钥文件")}
              description={t("A Google Cloud service account with access to this app in Play Console.", "使用能访问 Play Console 中此应用的 Google Cloud 服务账号。")}
            >
              <Button variant="outline" onClick={() => { setConnectionMethod("service"); setUserExpanded(true); }}>{gp("serviceAccount")}</Button>
            </SettingRow>
          </ListRowGroup>
        </DetailSection>
      )}

      {!meta && expanded && (
        /* Service-account path (secondary entry): reachable from the
           "Service account" button of the unconnected connector. */
        <DetailSection title={gp("serviceAccount")}>
          {serviceCredentialField}
          {packageTrackFields}
          <Text.Sans size="small" variant="muted">{gp("noPublish")}</Text.Sans>
          <FormActions>
            {saveButton}
            <Button variant="outline" onClick={() => setUserExpanded(false)}>{gp("cancel")}</Button>
          </FormActions>
        </DetailSection>
      )}

      {meta && (
        <DetailSection title={t("Connection", "连接")}>
          <ListRowGroup>
            <SettingRow
              title={gp(meta.credential_kind === "authorized_user" ? "authorizedAccount" : "serviceAccount")}
              description={<span className="font-mono [overflow-wrap:anywhere]">{meta.service_account_email}</span>}
            />
            {!needsConfig && (
              <SettingRow
                title={gp("packageName")}
                description={<>
                  <span className="block font-mono [overflow-wrap:anywhere]">{meta.package_name}</span>
                  <span className="block font-mono">{meta.internal_track} · {meta.closed_track} · {meta.production_track}</span>
                </>}
              />
            )}
            {!needsConfig && (
              <SettingRow
                title={t("Publish to Google Play", "发布到 Google Play")}
                description={meta.enabled
                  ? t("Releases of this app can be promoted to its Play tracks.", "此应用的版本可以推送到它的 Play 轨道。")
                  : t("Off: nothing is sent to Google Play.", "已关闭：不会向 Google Play 发送任何内容。")}
              >
                <Switch
                  aria-label={t("Publish to Google Play", "发布到 Google Play")}
                  checked={meta.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(next) => {
                    if (!next && !window.confirm(gp("confirmDisable"))) return;
                    toggle.mutate(next);
                  }}
                />
              </SettingRow>
            )}
          </ListRowGroup>
        </DetailSection>
      )}

      {needsConfig && (
        /* Connected via Google, configuration pending: the saved credential
           is reused by the save call, no second authorization. */
        <DetailSection title={t("Package and tracks", "包名和轨道")}>
          <Text.Sans size="small">{gp("needsConfigHelp")}</Text.Sans>
          {packageTrackFields}
          <Text.Sans size="small" variant="muted">{gp("noPublish")}</Text.Sans>
          <FormActions>{saveButton}</FormActions>
        </DetailSection>
      )}

      {meta && !needsConfig && !editing && (
        <DetailSection title={t("Checks and access", "检查与授权")}>
          <ListRowGroup>
            <SettingRow title={t("Check the connection", "检查连接")} description={gp("noPublish")}>
              <Button variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>
                {verify.isPending ? gp("testing") : gp("test")}
              </Button>
            </SettingRow>
            {reauthorizable && (
              <SettingRow title={t("Google authorization", "Google 授权")} description={gp("reauthorizeHelp")}>
                <Button variant="outline" disabled={authorize.isPending} onClick={startConnect}>{gp("reauthorize")}</Button>
              </SettingRow>
            )}
            <SettingRow
              title={t("Credential", "凭据")}
              description={t("Replace the stored credential with a service account key file.", "用服务账号密钥文件替换已保存的凭据。")}
            >
              <Button variant="outline" onClick={() => { setConnectionMethod("service"); setEditing(true); }}>{gp("replace")}</Button>
            </SettingRow>
          </ListRowGroup>
        </DetailSection>
      )}

      {meta?.package_name && !editing && (
        <DetailSection title={gp("reportsTitle")}>
          <ListRowGroup data-testid="google-play-reports">
            <SettingRow
              title={reportsGrant ? gp("reportsAccount") : t("Not authorized", "未授权")}
              description={<>
                {reportsGrant && <span className="block font-mono [overflow-wrap:anywhere]">{reportsGrant.account_email}</span>}
                <span className="block">{gp("reportsHelp")}</span>
              </>}
            >
              <Button variant="outline" disabled={authorize.isPending || !query.data?.oauth_available} onClick={startReports}>
                {gp(reportsGrant ? "reportsReauthorize" : "reportsAuthorize")}
              </Button>
              {reportsGrant && (
                <Button variant="outline" disabled={removeReports.isPending} onClick={() => {
                  if (window.confirm(gp("reportsConfirmRemove"))) removeReports.mutate();
                }}>{gp("reportsRemove")}</Button>
              )}
            </SettingRow>
          </ListRowGroup>
        </DetailSection>
      )}

      {meta && !needsConfig && editing && (
        <DetailSection title={gp("replace")}>
          {serviceCredentialField}
          {packageTrackFields}
          <Text.Sans size="small" variant="muted">{gp("noPublish")}</Text.Sans>
          <FormActions>
            {saveButton}
            <Button variant="outline" onClick={() => { setCredentialJson(""); setEditing(false); }}>{gp("cancel")}</Button>
          </FormActions>
        </DetailSection>
      )}

      {meta && (
        <DetailSection title={t("Danger zone", "危险操作")}>
          <DangerRow
            title={gp("unbind")}
            description={meta.credential_kind === "authorized_user"
              ? gp("disconnectHelp")
              : t("Deletes the stored credential, the package and the tracks.", "删除已保存的凭据、包名和轨道。")}
            disabled={remove.isPending}
            onClick={confirmUnbind}
          />
          {meta.credential_kind === "authorized_user" && (
            <TextLink className="text-footnote" render={<a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer" />} nativeButton={false}>
              {t("Google account connections", "Google 账号第三方连接")}
              <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
            </TextLink>
          )}
        </DetailSection>
      )}
    </div>
  );
}

function isTokenRejected(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.body as { code?: unknown } | null;
  return body?.code === "play_token_rejected";
}
